import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipDirectory } from '../scripts/zip.mjs';

test('zipDirectory writes a valid, reproducible archive with root-relative paths', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sm-zip-'));
  const src = path.join(dir, 'src');
  mkdirSync(path.join(src, 'icons'), { recursive: true });
  writeFileSync(path.join(src, 'manifest.json'), '{"version":"1.2.3"}');
  writeFileSync(path.join(src, 'icons', 'a.bin'), Buffer.alloc(5000, 7));

  const a = path.join(dir, 'a.zip');
  const b = path.join(dir, 'b.zip');
  assert.equal(await zipDirectory(src, a), 2);
  await zipDirectory(src, b);
  assert.deepEqual(readFileSync(a), readFileSync(b), 'byte-identical across runs');

  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
  } catch {
    return t.skip('unzip not installed');
  }
  assert.match(execFileSync('unzip', ['-t', a]).toString(), /No errors detected/);
  assert.equal(execFileSync('unzip', ['-p', a, 'manifest.json']).toString(), '{"version":"1.2.3"}');
  assert.match(execFileSync('unzip', ['-l', a]).toString(), /icons\/a\.bin/);
});
