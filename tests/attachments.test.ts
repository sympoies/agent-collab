import { describe, expect, it } from "vitest";

import { AttachmentReader } from "../src/loader/attachments";
import { Loader } from "../src/loader/loader";
import { FixtureSource } from "../src/source/fixture";
import { SourceError, type DirectoryEntry, type MessageSource } from "../src/source/types";
import { MARKER } from "./support";

const files = {
  ".agent-collab": MARKER,
  "topics/api/fields.md": "# Fields\n",
  "topics/api/data.csv": "a,b\n1,2\n",
  "topics/api/big.txt": "x".repeat(50),
};

async function open() {
  const source = new FixtureSource(files);
  const loader = new Loader(source);
  await loader.open();
  return { source, reader: loader.attachments };
}

describe("AttachmentReader", () => {
  it("describes a file with its size and lists each directory once per revision", async () => {
    const { source, reader } = await open();
    expect(await reader.info("topics/api/fields.md")).toEqual({
      path: "topics/api/fields.md",
      name: "fields.md",
      size: 9,
    });
    expect((await reader.info("topics/api/data.csv"))?.size).toBe(8);
    expect(source.listings.filter((path) => path === "topics/api")).toHaveLength(1);
  });

  it("reports a missing file or directory as not found", async () => {
    const { reader } = await open();
    expect(await reader.info("topics/api/missing.md")).toBeNull();
    expect(await reader.info("topics/nope/x.md")).toBeNull();
  });

  it("reads text within the cap and refuses a larger file without downloading it", async () => {
    const { source, reader } = await open();
    expect(await reader.readText("topics/api/fields.md", 100)).toEqual({
      state: "ready",
      text: "# Fields\n",
    });
    expect(await reader.readText("topics/api/big.txt", 10)).toEqual({
      state: "too-large",
      size: 50,
    });
    expect(source.reads).not.toContain("topics/api/big.txt");
  });

  it("reads bytes when the source can, and says so when it cannot", async () => {
    const { reader } = await open();
    const bytes = await reader.readBytes("topics/api/fields.md", 100);
    expect(bytes.state === "ready" && bytes.bytes.length).toBe(9);

    const textOnly: MessageSource = {
      head: () => Promise.resolve({ revision: "r", validator: null }),
      listDirectory: () =>
        Promise.resolve([
          { name: "a.png", path: "topics/a.png", kind: "file", objectId: "1", size: 3 },
        ]),
      readFile: () => Promise.resolve(""),
      rateLimit: () => null,
    };
    const unsupported = new AttachmentReader(textOnly, () => "r");
    expect(await unsupported.readBytes("topics/a.png", 100)).toEqual({ state: "unsupported" });
  });

  it("does nothing before the repository was opened", async () => {
    const reader = new AttachmentReader(new FixtureSource(files), () => null);
    await expect(reader.info("topics/api/fields.md")).rejects.toMatchObject({ kind: "unexpected" });
  });

  it("passes the provider link through", () => {
    const withLink: MessageSource = {
      head: () => Promise.resolve({ revision: "r", validator: null }),
      listDirectory: () => Promise.resolve([]),
      readFile: () => Promise.resolve(""),
      rateLimit: () => null,
      webLink: (path, revision) => ({
        url: `https://host.example/${revision ?? "none"}/${path}`,
        label: "GitHub",
      }),
    };
    expect(new AttachmentReader(withLink, () => "r").webLink("topics/a.md")).toEqual({
      url: "https://host.example/r/topics/a.md",
      label: "GitHub",
    });
    expect(new AttachmentReader(withLink, () => null).webLink("topics/a.md")?.url).toBe(
      "https://host.example/none/topics/a.md",
    );
    expect(
      new AttachmentReader(new FixtureSource(files), () => "r").webLink("topics/a.md"),
    ).toBeNull();
  });
});

function sizedSource(
  size: number | undefined,
  read: { text?: () => Promise<string>; bytes?: () => Promise<Uint8Array> },
): MessageSource & { calls: { text: number; bytes: number } } {
  const calls = { text: 0, bytes: 0 };
  const entry: DirectoryEntry = {
    name: "f.txt",
    path: "topics/f.txt",
    kind: "file",
    objectId: "o1",
    ...(size === undefined ? {} : { size }),
  };
  return {
    calls,
    head: () => Promise.resolve({ revision: "r", validator: null }),
    listDirectory: () => Promise.resolve([entry]),
    readFile: () => {
      calls.text += 1;
      return read.text?.() ?? Promise.resolve("");
    },
    readBytes: () => {
      calls.bytes += 1;
      return read.bytes?.() ?? Promise.resolve(new Uint8Array());
    },
    rateLimit: () => null,
  };
}

describe("AttachmentReader limits and caching", () => {
  const KB200 = 200 * 1024;
  const MB2 = 2 * 1024 * 1024;

  it("accepts a text file of exactly the cap and refuses one byte more", async () => {
    const exact = new AttachmentReader(
      sizedSource(KB200, { text: () => Promise.resolve("a".repeat(KB200)) }),
      () => "r",
    );
    expect((await exact.readText("topics/f.txt", KB200)).state).toBe("ready");
    const over = sizedSource(KB200 + 1, {});
    expect(await new AttachmentReader(over, () => "r").readText("topics/f.txt", KB200)).toEqual({
      state: "too-large",
      size: KB200 + 1,
    });
    expect(over.calls.text).toBe(0);
  });

  it("applies the same boundary to image bytes", async () => {
    const exact = new AttachmentReader(
      sizedSource(MB2, { bytes: () => Promise.resolve(new Uint8Array(MB2)) }),
      () => "r",
    );
    expect((await exact.readBytes("topics/f.txt", MB2)).state).toBe("ready");
    const over = sizedSource(MB2 + 1, {});
    expect((await new AttachmentReader(over, () => "r").readBytes("topics/f.txt", MB2)).state).toBe(
      "too-large",
    );
    expect(over.calls.bytes).toBe(0);
  });

  it("counts bytes, not characters, when the file turns out larger than the listing said", async () => {
    // 150,000 two-byte characters are 300,000 bytes, above the cap, although the text is short.
    const lying = sizedSource(10, { text: () => Promise.resolve("\u00e9".repeat(150_000)) });
    expect(await new AttachmentReader(lying, () => "r").readText("topics/f.txt", KB200)).toEqual({
      state: "too-large",
      size: 300_000,
    });
  });

  it("does not download a file whose size the source does not report", async () => {
    const unknown = sizedSource(undefined, { text: () => Promise.resolve("x") });
    const reader = new AttachmentReader(unknown, () => "r");
    expect(await reader.readText("topics/f.txt", KB200)).toEqual({ state: "unknown-size" });
    expect(await reader.readBytes("topics/f.txt", MB2)).toEqual({ state: "unknown-size" });
    expect(unknown.calls).toEqual({ text: 0, bytes: 0 });
  });

  it("reads a file once however often it is opened, and a failure is not cached", async () => {
    const source = sizedSource(3, {
      text: () => Promise.resolve("abc"),
      bytes: () => Promise.resolve(new Uint8Array(3)),
    });
    const reader = new AttachmentReader(source, () => "r");
    await reader.readText("topics/f.txt", KB200);
    await reader.readText("topics/f.txt", KB200);
    await reader.readBytes("topics/f.txt", MB2);
    await reader.readBytes("topics/f.txt", MB2);
    expect(source.calls).toEqual({ text: 1, bytes: 1 });

    let attempts = 0;
    const flaky = sizedSource(3, {
      text: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new SourceError("rate-limited", "topics/f.txt", 403))
          : Promise.resolve("abc");
      },
    });
    const flakyReader = new AttachmentReader(flaky, () => "r");
    await expect(flakyReader.readText("topics/f.txt", KB200)).rejects.toMatchObject({
      kind: "rate-limited",
    });
    expect(attempts).toBe(1);
    expect((await flakyReader.readText("topics/f.txt", KB200)).state).toBe("ready");
  });
});
