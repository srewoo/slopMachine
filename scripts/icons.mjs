// Draws the toolbar icon without image dependencies: a moss tile holding three text lines,
// the middle one cut short — a draft with something taken out.
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

// Signed-distance rounded rectangle, used for the tile and the bars; 4x4 supersampling for edges.
const rrect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

function png(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const moss = [47, 93, 74], paper = [250, 250, 248], ochre = [226, 178, 96];
  const bars = [ // [cx, cy, halfWidth, color] in a 1-unit box
    [0.5, 0.33, 0.27, paper],
    [0.385, 0.5, 0.155, paper],
    [0.5, 0.67, 0.27, paper],
  ];
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const x = (px + (sx + 0.5) / 4) / size, y = (py + (sy + 0.5) / 4) / size;
        if (rrect(x, y, 0.5, 0.5, 0.5, 0.5, 0.22) > 0) continue;
        let col = moss;
        for (const [cx, cy, hw, c] of bars) if (rrect(x, y, cx, cy, hw, 0.055, 0.055) <= 0) col = c;
        if (rrect(x, y, 0.655, 0.5, 0.06, 0.055, 0.055) <= 0) col = ochre; // the cut, marked
        acc = [acc[0] + col[0], acc[1] + col[1], acc[2] + col[2], acc[3] + 255];
      }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      const a = acc[3] / 16;
      raw[o] = a ? acc[0] / (acc[3] / 255) : 0;
      raw[o + 1] = a ? acc[1] / (acc[3] / 255) : 0;
      raw[o + 2] = a ? acc[2] / (acc[3] / 255) : 0;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export async function writeIcons(dir) {
  await mkdir(dir, { recursive: true });
  await Promise.all([16, 32, 48, 128].map((s) => writeFile(`${dir}/${s}.png`, png(s))));
}
