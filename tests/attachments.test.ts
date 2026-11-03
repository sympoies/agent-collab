import { describe, expect, it } from "vitest";

import { AttachmentReader } from "../src/loader/attachments";
import { Loader } from "../src/loader/loader";
import { FixtureSource } from "../src/source/fixture";
import type { MessageSource } from "../src/source/types";
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
