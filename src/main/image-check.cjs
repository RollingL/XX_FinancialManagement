'use strict';

// Server-side check for screenshot attachments before they are written to disk.
//
// The renderer already decodes the picture with createImageBitmap. This file is
// the second, independent gate in the main process: it walks the PNG / JPEG
// structure without decoding pixels, so a damaged, truncated or disguised file
// is refused even if a page bypasses the renderer check.

const { crc32 } = require('node:zlib');

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 20_000_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

const TOO_LARGE = '请选择不超过 20 MiB 的 PNG 或 JPEG 图片';
const WRONG_TYPE = '只支持有效的 PNG 或 JPEG 图片，不支持 PDF、SVG 或其他文件';
const DAMAGED = '图片已损坏或不完整，请换一张有效的 PNG / JPEG';
const TOO_MANY_PIXELS = '图片超过 2000 万像素，请裁剪或缩小后重试';

function imageError(message, status = 422) {
  return Object.assign(new Error(message), { status });
}

function checkSize(width, height) {
  if (!width || !height) throw imageError(DAMAGED);
  if (width * height > MAX_IMAGE_PIXELS) throw imageError(TOO_MANY_PIXELS);
}

// PNG: signature, then chunks of [length][type][data][crc]. The first chunk
// must be IHDR, at least one IDAT must exist, and the file ends with IEND.
function checkPng(bytes) {
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let hasHeader = false;
  let hasData = false;

  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (length > 0x7fffffff || dataEnd + 4 > bytes.length) throw imageError(DAMAGED);

    const type = bytes.toString('latin1', offset + 4, dataStart);
    const expectedCrc = bytes.readUInt32BE(dataEnd);
    if (crc32(bytes.subarray(offset + 4, dataEnd)) !== expectedCrc) throw imageError(DAMAGED);

    if (!hasHeader) {
      if (type !== 'IHDR' || length !== 13) throw imageError(DAMAGED);
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      hasHeader = true;
      checkSize(width, height);
    } else if (type === 'IHDR') {
      throw imageError(DAMAGED);
    }

    if (type === 'IDAT') hasData = true;
    if (type === 'IEND') {
      if (length !== 0 || !hasData) throw imageError(DAMAGED);
      return { suffix: '.png', mime: 'image/png', width, height };
    }
    offset = dataEnd + 4;
  }
  throw imageError(DAMAGED);
}

// Start-of-frame markers carry the picture size. C4 (DHT), C8 (reserved) and
// CC (DAC) share the range but are not frames.
function isStartOfFrame(marker) {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}

// JPEG: SOI, then marker segments up to the first scan (SOS). A frame header
// must come before the scan, and an end marker (EOI) must follow it.
function checkJpeg(bytes) {
  let offset = 2;
  let width = 0;
  let height = 0;

  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw imageError(DAMAGED);
    let marker = bytes[offset + 1];
    while (marker === 0xff && offset + 2 < bytes.length) {
      offset += 1;
      marker = bytes[offset + 1];
    }
    offset += 2;

    if (marker === 0xd8 || marker === 0xd9) throw imageError(DAMAGED);
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) throw imageError(DAMAGED);

    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw imageError(DAMAGED);

    if (isStartOfFrame(marker)) {
      if (length < 8) throw imageError(DAMAGED);
      height = bytes.readUInt16BE(offset + 3);
      width = bytes.readUInt16BE(offset + 5);
      checkSize(width, height);
    }

    if (marker === 0xda) {
      if (!width || !height) throw imageError(DAMAGED);
      if (bytes.indexOf(JPEG_END, offset + length) < 0) throw imageError(DAMAGED);
      return { suffix: '.jpg', mime: 'image/jpeg', width, height };
    }
    offset += length;
  }
  throw imageError(DAMAGED);
}

/**
 * Checks a screenshot attachment and returns its file suffix, MIME type and size.
 * Throws an Error with a user-facing Chinese message and an HTTP-like status.
 */
function checkImage(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw imageError(TOO_LARGE, 413);
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return checkPng(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return checkJpeg(bytes);
  throw imageError(WRONG_TYPE);
}

module.exports = { checkImage, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS };
