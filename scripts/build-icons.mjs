// Generates desktop app icons (icns/ico/png) with no external dependencies:
// a small SDF rasterizer draws the glyph, then PNG/ICNS/ICO are encoded by hand.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const output = resolve(import.meta.dirname, "../build/icons");
const sizes = [16, 32, 64, 128, 256, 512, 1024];

// Signed distance (positive inside) to a centered rounded rectangle.
function roundedRect(x, y, w, h, r) {
  const qx = Math.abs(x - w / 2) - (w / 2 - r);
  const qy = Math.abs(y - h / 2) - (h / 2 - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return -(outside + inside - r);
}
function smooth(d) {
  const aa = 0.7; // d is positive inside the shape
  return Math.min(1, Math.max(0, 0.5 + d / aa));
}
function mix(a, b, t) {
  return a.map((c, i) => Math.round(c + (b[i] - c) * t));
}
function draw(size) {
  const pixels = new Uint8Array(size * size * 4);
  const top = [15, 118, 110]; // teal-700
  const bottom = [20, 184, 166]; // teal-500
  const cross = [255, 255, 255];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5,
        py = y + 0.5,
        i = (y * size + x) * 4;
      const tile = smooth(roundedRect(px, py, size, size, size * 0.22));
      if (tile <= 0) continue;
      const arm = size * 0.14,
        half = size * 0.46;
      const vertical =
        px > size / 2 - arm &&
        px < size / 2 + arm &&
        py > size / 2 - half &&
        py < size / 2 + half;
      const horizontal =
        py > size / 2 - arm &&
        py < size / 2 + arm &&
        px > size / 2 - half &&
        px < size / 2 + half;
      const inCross = vertical || horizontal;
      const base = mix(top, bottom, y / size);
      const color = inCross ? cross : base;
      pixels[i] = color[0];
      pixels[i + 1] = color[1];
      pixels[i + 2] = color[2];
      pixels[i + 3] = Math.round(255 * tile);
    }
  }
  return pixels;
}

// --- Minimal PNG encoder ---
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  return Buffer.concat([head, data, tail]);
}
function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(
      raw,
      y * (size * 4 + 1) + 1,
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(output, { recursive: true });
const images = new Map();
for (const size of sizes) {
  const encoded = png(size, draw(size));
  images.set(size, encoded);
  if (size <= 512) writeFileSync(join(output, `icon_${size}.png`), encoded);
}

// --- ICNS: PNG payloads under OSType entries ---
const icnsTypes = [
  [32, "ic11"],
  [64, "ic12"],
  [128, "ic07"],
  [256, "ic08"],
  [512, "ic09"],
  [1024, "ic10"],
];
const icns = [];
for (const [size, type] of icnsTypes) {
  const data = images.get(size);
  const entry = Buffer.alloc(8);
  entry.write(type, 0, "ascii");
  entry.writeUInt32BE(data.length + 8, 4);
  icns.push(entry, data);
}
const header = Buffer.alloc(8);
header.write("icns", 0, "ascii");
const icnsBody = Buffer.concat(icns);
header.writeUInt32BE(icnsBody.length + 8, 4);
writeFileSync(join(output, "icon.icns"), Buffer.concat([header, icnsBody]));

// --- ICO: PNG-compressed entries (Vista+) ---
const icoSizes = [16, 32, 48, 256];
const entries = [],
  blobs = [];
let offset = 6 + icoSizes.length * 16;
for (const size of icoSizes) {
  const data =
    images.get(size) ??
    png(size, draw(size));
  const entry = Buffer.alloc(16);
  entry[0] = size === 256 ? 0 : size;
  entry[1] = size === 256 ? 0 : size;
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(data.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += data.length;
  entries.push(entry);
  blobs.push(data);
}
const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2); // icon
dir.writeUInt16LE(icoSizes.length, 4);
writeFileSync(
  join(output, "icon.ico"),
  Buffer.concat([dir, ...entries, ...blobs]),
);
console.log(`icons written to ${output}`);
