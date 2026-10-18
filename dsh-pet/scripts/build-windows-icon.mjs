import { deflateSync, inflateSync } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';

const pngPath = new URL('../assets/dsh-pet-icon-16.png', import.meta.url);
const icoPath = new URL('../assets/dsh-pet-icon.ico', import.meta.url);
const png = await readFile(pngPath);
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

if (!png.subarray(0, 8).equals(signature) || png.toString('ascii', 12, 16) !== 'IHDR') {
  throw new Error('assets/dsh-pet-icon-16.png is not a valid PNG');
}

const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
if (png[24] !== 8 || png[25] !== 6 || png[28] !== 0) {
  throw new Error('Expected a non-interlaced 8-bit RGBA PNG');
}
if (width !== 16 || height !== 16) {
  throw new Error(`Expected a 16×16 icon, got ${width}×${height}`);
}

const chunks = [];
for (let offset = 8; offset < png.length;) {
  const length = png.readUInt32BE(offset);
  const type = png.toString('ascii', offset + 4, offset + 8);
  if (type === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
  offset += 12 + length;
}

const raw = inflateSync(Buffer.concat(chunks));
const sourcePixels = Buffer.alloc(width * height * 4);
const bytesPerPixel = 4;
const sourceStride = width * bytesPerPixel;
const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

for (let y = 0; y < height; y += 1) {
  const filter = raw[y * (sourceStride + 1)];
  const inputStart = y * (sourceStride + 1) + 1;
  const rowStart = y * sourceStride;
  for (let x = 0; x < sourceStride; x += 1) {
    const value = raw[inputStart + x];
    const left = x >= bytesPerPixel ? sourcePixels[rowStart + x - bytesPerPixel] : 0;
    const above = y > 0 ? sourcePixels[rowStart + x - sourceStride] : 0;
    const upperLeft = y > 0 && x >= bytesPerPixel ? sourcePixels[rowStart + x - sourceStride - bytesPerPixel] : 0;
    let predictor = 0;
    if (filter === 1) predictor = left;
    else if (filter === 2) predictor = above;
    else if (filter === 3) predictor = Math.floor((left + above) / 2);
    else if (filter === 4) predictor = paeth(left, above, upperLeft);
    else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}`);
    sourcePixels[rowStart + x] = (value + predictor) & 0xff;
  }
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < crcTable.length; n += 1) {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[n] = value >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, 8 + data.length)) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return chunk;
}

function scaledPng(size) {
  const pixels = Buffer.alloc(size * size * bytesPerPixel);
  for (let y = 0; y < size; y += 1) {
    const sourceY = Math.floor((y * height) / size);
    for (let x = 0; x < size; x += 1) {
      const sourceX = Math.floor((x * width) / size);
      const sourceOffset = (sourceY * width + sourceX) * bytesPerPixel;
      const targetOffset = (y * size + x) * bytesPerPixel;
      sourcePixels.copy(pixels, targetOffset, sourceOffset, sourceOffset + bytesPerPixel);
    }
  }

  const stride = size * bytesPerPixel;
  const scanlines = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y += 1) {
    const scanlineOffset = y * (stride + 1);
    pixels.copy(scanlines, scanlineOffset + 1, y * stride, (y + 1) * stride);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const signatureBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signatureBytes,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const sizes = [16, 32, 48, 64, 128, 256];
const frames = sizes.map((size) => ({ size, png: scaledPng(size) }));
const directorySize = 6 + frames.length * 16;
const ico = Buffer.alloc(directorySize + frames.reduce((sum, frame) => sum + frame.png.length, 0));
ico.writeUInt16LE(0, 0); // reserved
ico.writeUInt16LE(1, 2); // icon image
ico.writeUInt16LE(frames.length, 4); // image count
let imageOffset = directorySize;
frames.forEach((frame, index) => {
  const entryOffset = 6 + index * 16;
  ico[entryOffset] = frame.size === 256 ? 0 : frame.size;
  ico[entryOffset + 1] = frame.size === 256 ? 0 : frame.size;
  ico[entryOffset + 2] = 0; // use PNG color count
  ico[entryOffset + 3] = 0;
  ico.writeUInt16LE(1, entryOffset + 4); // color planes
  ico.writeUInt16LE(32, entryOffset + 6); // bits per pixel
  ico.writeUInt32LE(frame.png.length, entryOffset + 8);
  ico.writeUInt32LE(imageOffset, entryOffset + 12);
  frame.png.copy(ico, imageOffset);
  imageOffset += frame.png.length;
});

await writeFile(icoPath, ico);
process.stdout.write(`Generated ${icoPath.pathname} with nearest-neighbor frames: ${sizes.join(', ')} px\n`);
