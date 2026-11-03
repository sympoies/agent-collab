import { describe, expect, it } from "vitest";

import { IMAGE_MAX_PIXELS, imageDimensions } from "../src/message/image";
import { pngBytes } from "./support";

const u16be = (n: number) => [(n >> 8) & 255, n & 255];
const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16le = (n: number) => [n & 255, (n >> 8) & 255];
const u24le = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));

const png = pngBytes;

describe("imageDimensions", () => {
  it("reads a PNG header", () => {
    expect(imageDimensions(png(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it.each(["GIF87a", "GIF89a"])("reads a %s header", (magic) => {
    expect(
      imageDimensions(Uint8Array.from([...ascii(magic), ...u16le(320), ...u16le(200), 0])),
    ).toEqual({
      width: 320,
      height: 200,
    });
  });

  it("reads a JPEG start-of-frame after other segments", () => {
    const app0 = [0xff, 0xe0, ...u16be(16), ...new Array<number>(14).fill(0)];
    const sof = [0xff, 0xc2, ...u16be(17), 8, ...u16be(1200), ...u16be(1600), 3];
    expect(imageDimensions(Uint8Array.from([0xff, 0xd8, ...app0, ...sof]))).toEqual({
      width: 1600,
      height: 1200,
    });
  });

  it("reads lossy, lossless and extended WebP headers", () => {
    const riff = (chunk: number[]) => [
      ...ascii("RIFF"),
      ...u32be(chunk.length + 4),
      ...ascii("WEBP"),
      ...chunk,
    ];
    const vp8 = riff([
      ...ascii("VP8 "),
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0x9d,
      0x01,
      0x2a,
      ...u16le(300),
      ...u16le(100),
    ]);
    expect(imageDimensions(Uint8Array.from(vp8))).toEqual({ width: 300, height: 100 });
    const bits = (299 | (99 << 14)) >>> 0;
    const vp8l = riff([
      ...ascii("VP8L"),
      0,
      0,
      0,
      0,
      0x2f,
      bits & 255,
      (bits >> 8) & 255,
      (bits >> 16) & 255,
      (bits >> 24) & 255,
    ]);
    expect(imageDimensions(Uint8Array.from(vp8l))).toEqual({ width: 300, height: 100 });
    const vp8x = riff([...ascii("VP8X"), 10, 0, 0, 0, 0, 0, 0, 0, ...u24le(4999), ...u24le(2999)]);
    expect(imageDimensions(Uint8Array.from(vp8x))).toEqual({ width: 5000, height: 3000 });
  });

  it.each([
    ["empty", new Uint8Array()],
    ["truncated PNG", png(1, 1).slice(0, 20)],
    ["text", Uint8Array.from(ascii("not an image at all, just some text"))],
    ["JPEG without a frame", Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])],
    ["zero-sized PNG", png(0, 10)],
  ])("returns null for %s", (_name, bytes) => {
    expect(imageDimensions(bytes)).toBeNull();
  });

  it("exposes the pixel cap used to refuse decompression bombs", () => {
    expect(IMAGE_MAX_PIXELS).toBe(25_000_000);
  });
});
