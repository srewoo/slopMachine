import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { cleanExport, docTarget, isPdfBytes, originFor, pageText, pdfText, type PdfItem, type PdfJs } from '../src/shared/document.ts';

/** A real PDF: one Helvetica text line per entry, `y` from the bottom of a US Letter page. */
function makePdf(pages: readonly (readonly { text: string; y: number }[])[]): Uint8Array {
  const objs: string[] = [];
  const add = (body: string) => objs.push(body);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  add(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (const [i, lines] of pages.entries()) {
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    const stream = lines.map((l) => `BT /F1 11 Tf 72 ${l.y} Td (${l.text.replace(/[()\\]/g, '\\$&')}) Tj ET`).join('\n');
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let out = '%PDF-1.4\n';
  const offsets = objs.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

test('docTarget recognizes Google Docs, Slides and PDFs, nothing else', () => {
  const d = docTarget('https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit?tab=t.0');
  assert.ok(d && d.kind === 'gdoc');
  assert.equal(d.exportUrl, 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/export?format=txt');
  assert.equal(docTarget('https://docs.google.com/document/u/1/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit')?.kind, 'gdoc');
  assert.equal(docTarget('https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit')?.kind, 'gslides');
  const pdf = docTarget('https://example.com/papers/Q3%20Report.PDF?dl=1');
  assert.deepEqual(pdf, { kind: 'pdf', url: 'https://example.com/papers/Q3%20Report.PDF?dl=1', name: 'Q3 Report.PDF' });
  assert.equal(originFor(pdf!), 'https://example.com/*');
  assert.equal(originFor(docTarget('http://example.com/a.pdf')!), null, 'plain http is not fetched');
  for (const u of [undefined, '', 'chrome://newtab', 'file:///Users/me/a.pdf', 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit', 'https://evil.example/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345', 'https://example.com/pdf-guide']) {
    assert.equal(docTarget(u), null, String(u));
  }
});

test('cleanExport: BOM and CRLF out, one blank line between paragraphs', () => {
  assert.equal(cleanExport('﻿Title\r\n\r\nFirst para.\r\nSecond para.  \r\n'), 'Title\n\nFirst para.\n\nSecond para.');
});

const run = (str: string, y: number, hasEOL = true): PdfItem => ({ str, transform: [11, 0, 0, 11, 72, y], height: 11, hasEOL });

test('pageText joins wrapped lines, undoes hyphenation, keeps paragraph gaps, drops page numbers', () => {
  const items = [
    run('The rollout starts in March and covers every', 700), run('region except the two pilot sites, which', 686),
    run('move first. Each team gets a check-', 672), run('list before go-live.', 658),
    run('Support hours stay the same.', 630),
    run('7', 40),
  ];
  assert.equal(pageText(items), 'The rollout starts in March and covers every region except the two pilot sites, which move first. Each team gets a checklist before go-live.\n\nSupport hours stay the same.');
  assert.equal(pageText([run('Page 3 of 9', 40)]), '');
  // Runs on one line without hasEOL are concatenated; pdf.js sends the spaces as runs.
  assert.equal(pageText([run('Hello', 700, false), run(' ', 700, false), run('world.', 700)]), 'Hello world.');
});

test('pdfText reads a real PDF through pdf.js, page by page', async () => {
  const data = makePdf([
    [{ text: 'Here is what nobody tells you about onboarding: it is the', y: 700 }, { text: 'first week that decides retention.', y: 686 }, { text: '1', y: 40 }],
    [{ text: 'The agent reads mail. The assistant drafts replies.', y: 700 }],
  ]);
  assert.ok(isPdfBytes(data));
  assert.ok(!isPdfBytes(new TextEncoder().encode('<html>')));
  const r = await pdfText(pdfjs as unknown as PdfJs, data, 12_000);
  assert.equal(r.pages, 2);
  assert.equal(r.readPages, 2);
  assert.equal(r.text, 'Here is what nobody tells you about onboarding: it is the first week that decides retention.\n\nThe agent reads mail. The assistant drafts replies.');
});

test('pdfText stops reading once it has enough text', async () => {
  const page = [{ text: 'A sentence long enough to count for something here.', y: 700 }];
  const r = await pdfText(pdfjs as unknown as PdfJs, makePdf([page, page, page, page]), 60);
  assert.equal(r.pages, 4);
  assert.equal(r.readPages, 2);
});
