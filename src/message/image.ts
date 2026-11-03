// Reads the pixel size from an image header, so a small file that decodes to a huge bitmap
// ("decompression bomb") is refused before it is handed to the browser.

/** Largest image, in pixels, that is previewed. */
export const IMAGE_MAX_PIXELS = 25_000_000;

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

const u16be = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, at: number) =>
  (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, at: number) =>
  (((b[at] ?? 0) << 24) | ((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0)) >>>
  0;
const ascii = (b: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...Array.from(b.slice(at, at + length)));

function sized(width: number, height: number): ImageSize | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

function jpeg(bytes: Uint8Array): ImageSize | null {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    const length = u16be(bytes, at + 2);
    // SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return at + 9 <= bytes.length ? sized(u16be(bytes, at + 7), u16be(bytes, at + 5)) : null;
    }
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

function webp(bytes: Uint8Array): ImageSize | null {
  const kind = ascii(bytes, 12, 4);
  if (kind === "VP8X") return sized(u24le(bytes, 24) + 1, u24le(bytes, 27) + 1);
  if (kind === "VP8L" && bytes[20] === 0x2f) {
    const bits =
      (bytes[21] ?? 0) |
      ((bytes[22] ?? 0) << 8) |
      ((bytes[23] ?? 0) << 16) |
      ((bytes[24] ?? 0) << 24);
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return sized(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
  }
  return null;
}

/** The pixel size of a PNG, GIF, JPEG or WebP image, or null when the header is not readable. */
export function imageDimensions(bytes: Uint8Array): ImageSize | null {
  if (bytes.length >= 24 && ascii(bytes, 1, 3) === "PNG" && ascii(bytes, 12, 4) === "IHDR") {
    return sized(u32be(bytes, 16), u32be(bytes, 20));
  }
  if (bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) {
    return sized(u16le(bytes, 6), u16le(bytes, 8));
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes);
  if (bytes.length >= 25 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return webp(bytes);
  }
  return null;
}
