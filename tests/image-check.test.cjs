const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkImage, MAX_IMAGE_BYTES } = require('../spike/image-check.cjs');
const { syntheticPng, pngHeaderOnly } = require('./synthetic-image.cjs');

const png = fs.readFileSync(path.join(__dirname, 'fixtures/synthetic-payment.png'));
const jpeg = fs.readFileSync(path.join(__dirname, 'fixtures/synthetic-receipt.jpg'));
const DAMAGED = /损坏或不完整/;

function rejects(bytes, message, status = 422) {
  assert.throws(
    () => checkImage(bytes),
    (error) => message.test(error.message) && error.status === status,
  );
}

// Offset of the first JPEG start-of-frame segment (marker C0..CF except C4/C8/CC).
function frameOffset(bytes) {
  let offset = 2;
  for (;;) {
    const marker = bytes[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return offset;
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
}

test('accepts the synthetic PNG and JPEG fixtures and reports their type and size', () => {
  assert.deepEqual(checkImage(png), {
    suffix: '.png',
    mime: 'image/png',
    width: 850,
    height: 720,
  });
  assert.deepEqual(checkImage(jpeg), {
    suffix: '.jpg',
    mime: 'image/jpeg',
    width: 900,
    height: 900,
  });
  assert.equal(checkImage(syntheticPng({ width: 3, height: 1 })).width, 3);
});

test('refuses empty, non-buffer and over-size input before looking inside', () => {
  for (const value of [undefined, 'not bytes', new Uint8Array(png), Buffer.alloc(0)])
    rejects(value, /20 MiB/, 413);
  const large = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  png.copy(large);
  rejects(large, /20 MiB/, 413);
});

test('refuses files that are not PNG or JPEG, whatever their name', () => {
  for (const bytes of [
    Buffer.from('%PDF-1.7 synthetic'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    Buffer.from('GIF89a synthetic'),
    Buffer.from([0xff, 0xd8]),
  ])
    rejects(bytes, /只支持有效的 PNG 或 JPEG/);
});

test('refuses damaged, truncated or incomplete PNG files', () => {
  const flipped = Buffer.from(png);
  flipped[flipped.length - 20] ^= 1;
  const valid = syntheticPng();
  const withoutData = Buffer.concat([valid.subarray(0, 33), valid.subarray(valid.length - 12)]);
  const headerSecond = Buffer.concat([valid.subarray(0, 8), valid.subarray(33)]);
  for (const bytes of [
    flipped,
    png.subarray(0, png.length - 12),
    png.subarray(0, png.length - 1),
    png.subarray(0, 40),
    withoutData,
    headerSecond,
  ])
    rejects(bytes, DAMAGED);
  rejects(pngHeaderOnly(0, 10), DAMAGED);
});

test('refuses PNG and JPEG files over 20 million pixels', () => {
  rejects(pngHeaderOnly(5000, 4001), /2000 万像素/);
  assert.equal(checkImage(pngHeaderOnly(5000, 4000)).width, 5000);
  const large = Buffer.from(jpeg),
    frame = frameOffset(large);
  large.writeUInt16BE(4001, frame + 5);
  large.writeUInt16BE(5000, frame + 7);
  rejects(large, /2000 万像素/);
});

test('refuses damaged or truncated JPEG files', () => {
  const noFrame = Buffer.from(jpeg);
  noFrame[frameOffset(noFrame) + 1] = 0xc4;
  const badMarker = Buffer.from(jpeg);
  badMarker[4 + badMarker.readUInt16BE(4)] = 0x00; // the byte where the second segment starts
  for (const bytes of [
    jpeg.subarray(0, jpeg.length - 2),
    jpeg.subarray(0, 200),
    noFrame,
    badMarker,
  ])
    rejects(bytes, DAMAGED);
});
