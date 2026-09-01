#!/usr/bin/env node
/**
 * make-icons.js — generates the app icons as PNGs, no dependencies, no CDN.
 *
 * Mark: three white sweep strokes on WSS maroon — a scrubber pass across a floor.
 * Run when the mark changes; the PNGs are committed so a deploy needs no toolchain.
 *
 * Usage: node tools/make-icons.js [outdir]      (default: docs/icons)
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const MAROON = [0xB7, 0x1C, 0x1C];
const WHITE = [0xFF, 0xFF, 0xFF];

// ------------------------------------------------------------------ png guts
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  // 10,11,12 = deflate / adaptive filter / no interlace (all 0)

  const stride = width * 4;
  const rawBytes = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rawBytes[y * (stride + 1)] = 0; // filter: none
    rgba.copy(rawBytes, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rawBytes, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// -------------------------------------------------------------------- the mark
/**
 * @param size    pixel size
 * @param inset   0..1 fraction of the canvas kept clear around the mark
 *                (maskable icons need a safe zone)
 */
function drawIcon(size, inset) {
  const buf = Buffer.alloc(size * size * 4);
  const S = 1 / (1 - 2 * inset);            // scale from padded box to unit box
  const toUnit = (p) => (p / size - inset) * S;

  // Three strokes, in unit space: [yTop, yBottom, xLeft, xRight]
  const BARS = [
    [0.20, 0.325, 0.10, 0.90],
    [0.435, 0.560, 0.10, 0.72],
    [0.670, 0.795, 0.10, 0.52],
  ];
  const SLANT = 0.10;   // strokes lean right as they rise — motion, not a stack
  const ROUND = 0.062;  // end-cap radius in unit space

  for (let y = 0; y < size; y++) {
    const uy = toUnit(y + 0.5);
    for (let x = 0; x < size; x++) {
      const ux = toUnit(x + 0.5);
      let ink = false;

      for (const [y0, y1, x0, x1] of BARS) {
        const cy = (y0 + y1) / 2;
        const r = (y1 - y0) / 2;
        const shift = (0.5 - cy) * SLANT;          // higher bar, further right
        const a = x0 + shift, b = x1 + shift;
        const dy = uy - cy;
        if (Math.abs(dy) > r) continue;
        // capsule: straight middle, rounded ends
        if (ux >= a + ROUND && ux <= b - ROUND) { ink = true; break; }
        const cx = ux < a + ROUND ? a + ROUND : b - ROUND;
        const dx = ux - cx;
        if (dx * dx + dy * dy <= ROUND * ROUND) { ink = true; break; }
      }

      const [r, g, b2] = ink ? WHITE : MAROON;
      const i = (y * size + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b2; buf[i + 3] = 255;
    }
  }
  return png(size, size, buf);
}

// ------------------------------------------------------------------------ main
const outdir = process.argv[2] || path.join(HERE, '..', 'docs', 'icons');
fs.mkdirSync(outdir, { recursive: true });

const FILES = [
  ['icon-192.png', 192, 0.10],
  ['icon-512.png', 512, 0.10],
  ['icon-180.png', 180, 0.10],            // apple-touch-icon
  ['icon-512-maskable.png', 512, 0.20],   // safe zone for Android masking
];

for (const [name, size, inset] of FILES) {
  const file = path.join(outdir, name);
  fs.writeFileSync(file, drawIcon(size, inset));
  console.log(`${name}  ${size}x${size}  ${fs.statSync(file).size} bytes`);
}
