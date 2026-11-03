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
      webLink: (path) => ({ url: `https://host.example/${path}`, label: "GitHub" }),
    };
    expect(new AttachmentReader(withLink, () => "r").webLink("topics/a.md")).toEqual({
      url: "https://host.example/topics/a.md",
      label: "GitHub",
    });
    expect(
      new AttachmentReader(new FixtureSource(files), () => "r").webLink("topics/a.md"),
    ).toBeNull();
  });
});
