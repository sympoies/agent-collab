// Collaboration protocol v2 (docs/design/protocol-v2.md): the marker, attachments under
// `topics/<topic>/files/YYYY-MM/` and the month-split topic index. Fixtures only.

import { describe, expect, it } from "vitest";

import { EMPTY_TOPIC_PREFERENCES, unreadOf } from "../src/identity/topic-preferences";
import { Loader } from "../src/loader/loader";
import { readTopicList, topicLoader } from "../src/loader/topic-reader";
import { TopicSession } from "../src/loader/topic-session";
import { FixtureSource } from "../src/source/fixture";
import { messageText } from "./support";

const V1 = "collab-protocol: 1\ninbox-layout: topic\nparticipants: alice-agent, bob-agent\n";
const V2 = "collab-protocol: 1\ninbox-layout: topic-v2\nparticipants: alice-agent, bob-agent\n";

const id = (month: string, day: number) =>
  `${month}-${String(day).padStart(2, "0")}T0900-alice-agent-api-01`;
const messagePath = (month: string, day: number) =>
  `topics/api/inbox/${month}/${id(month, day)}.md`;

function messages(month: string, days: readonly number[], refs = ""): Record<string, string> {
  return Object.fromEntries(
    days.map((day) => [
      messagePath(month, day),
      messageText(id(month, day), "alice-agent", "api", { refs }),
    ]),
  );
}

const HEADER =
  "| id | from | to | type | topic | reply_to | needs | summary |\n|---|---|---|---|---|---|---|---|";
const row = (month: string, day: number) =>
  `| ${id(month, day)} | alice-agent | bob-agent | info | api |  | none | s |`;
const table = (rows: readonly (readonly [string, number])[]) =>
  [HEADER, ...rows.map(([month, day]) => row(month, day))].join("\n");
const monthLinks = (months: readonly string[]) =>
  ["", "## Older months", "", ...months.map((m) => `- [${m}](index/${m}.md)`)].join("\n");

const days = (month: string, list: readonly number[]) => list.map((day) => [month, day] as const);

/** A v2 topic with three months; index.md holds November and the end of October. */
function v2Repository(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ".agent-collab": V2,
    "index.md": "| topic | title | status |\n|---|---|---|\n| api | API | open |\n",
    "topics/api/TOPIC.md": "---\ntitle: API\n---\n",
    ...messages("2026-09", [1, 2]),
    ...messages("2026-10", [1, 2, 3]),
    ...messages("2026-11", [1, 2]),
    "topics/api/index.md": `${table([...days("2026-10", [3]), ...days("2026-11", [1, 2])])}\n${monthLinks(["2026-11", "2026-10", "2026-09"])}\n`,
    "topics/api/index/2026-11.md": table(days("2026-11", [1, 2])),
    "topics/api/index/2026-10.md": table(days("2026-10", [1, 2, 3])),
    "topics/api/index/2026-09.md": table(days("2026-09", [1, 2])),
    "topics/api/open.md": "",
    "topics/api/files/2026-11/report.csv": "a,b\n1,2\n",
    "topics/api/files/2026-11/report.csv.md": "Weekly numbers.\n",
    "topics/api/files/2026-11/notes.md": "# Notes\n",
    "topics/api/files/2026-10/old.txt": "old\n",
    "topics/api/files/scratch/stray.txt": "not a month\n",
    ...extra,
  };
}

describe("the protocol v2 marker (inbox-layout: topic-v2)", () => {
  it("is read as the topic layout by the topic list, the session and the loader", async () => {
    const source = new FixtureSource(v2Repository());
    expect((await readTopicList(source)).topics.map((t) => t.name)).toEqual(["api"]);
    const session = new TopicSession(source);
    await session.open();
    expect(session.inboxLayout).toBe("topic");
    const loader = topicLoader(source, "api");
    await loader.open();
    expect(loader.getSnapshot().items.length).toBeGreaterThan(0);
  });

  it("refuses any protocol line but 1, whatever the layout", async () => {
    for (const marker of [
      "collab-protocol: 2\n",
      "collab-protocol: 2\ninbox-layout: topic\n",
      "collab-protocol: 2\ninbox-layout: topic-v2\n",
      "collab-protocol: 2\ninbox-layout: monthly\n",
      "collab-protocol: 3\ninbox-layout: topic-v2\n",
    ]) {
      const source = new FixtureSource({ ".agent-collab": marker });
      const detail = marker.split("\n", 1)[0];
      await expect(readTopicList(source), marker).rejects.toMatchObject({
        code: "protocol",
        detail,
      });
      await expect(new Loader(source).open(), marker).rejects.toMatchObject({
        code: "protocol",
        detail,
      });
    }
  });
});

describe("a v2 topic folder", () => {
  it("loads messages from inbox/ only: files/ and index/ are never messages", async () => {
    const loader = topicLoader(new FixtureSource(v2Repository()), "api", { pageSize: 50 });
    await loader.open();
    const paths = loader
      .getSnapshot()
      .items.map((item) => (item.kind === "message" ? item.message.path : item.path));
    expect(paths).toHaveLength(7);
    expect(paths.every((path) => path.startsWith("topics/api/inbox/"))).toBe(true);
  });

  it("lists attachments from files/YYYY-MM, newest month first, with sidecars attached", async () => {
    const source = new FixtureSource(v2Repository());
    const session = new TopicSession(source);
    await session.open();
    const newest = await session.files("api");
    expect(newest).toEqual({
      month: "2026-11",
      older: "2026-10",
      files: [
        { path: "topics/api/files/2026-11/notes.md", name: "notes.md", size: 8, sidecar: null },
        {
          path: "topics/api/files/2026-11/report.csv",
          name: "report.csv",
          size: 8,
          sidecar: "topics/api/files/2026-11/report.csv.md",
        },
      ],
    });
    expect(await session.files("api", "2026-10")).toEqual({
      month: "2026-10",
      older: null,
      files: [
        { path: "topics/api/files/2026-10/old.txt", name: "old.txt", size: 4, sidecar: null },
      ],
    });
    // Only the files folders were listed; no message, index or attachment was read for it.
    expect(source.reads.filter((path) => path.startsWith("topics/api/files"))).toEqual([]);
    expect(await session.files("api", "scratch")).toBeNull();
    expect(await session.files("api", "2026-08")).toBeNull();
    expect(await session.files("../x")).toBeNull();
  });

  it("resolves and opens refs that point into files/", async () => {
    const ref = "topics/api/files/2026-11/report.csv";
    const source = new FixtureSource(v2Repository(messages("2026-11", [3], ref)));
    const loader = topicLoader(source, "api");
    await loader.open();
    expect(await loader.attachments.info(ref)).toEqual({ path: ref, name: "report.csv", size: 8 });
    expect(await loader.attachments.readText(ref, 1024)).toEqual({
      state: "ready",
      text: "a,b\n1,2\n",
    });
  });
});

describe("the month-split topic index", () => {
  it("takes the newest id from index.md and marks its ids as recent only", async () => {
    const source = new FixtureSource(v2Repository());
    const session = new TopicSession(source);
    await session.open();
    expect(await session.digest("api")).toEqual({
      count: null,
      newestId: id("2026-11", 2),
      fromIndex: true,
      ids: [id("2026-10", 3), id("2026-11", 1), id("2026-11", 2)],
      idsComplete: false,
    });
    // The month files are read only when asked for.
    expect(source.reads.filter((path) => path.startsWith("topics/api/index/"))).toEqual([]);
  });

  it("counts a complete v2 index (no older month) like v1", async () => {
    const files = v2Repository({
      "topics/api/index.md": `${table(days("2026-11", [1, 2]))}\n${monthLinks(["2026-11"])}\n`,
    });
    const session = new TopicSession(new FixtureSource(files));
    await session.open();
    expect(await session.digest("api")).toEqual({
      count: 2,
      newestId: id("2026-11", 2),
      fromIndex: true,
      ids: [id("2026-11", 1), id("2026-11", 2)],
    });
  });

  it("gives an unread count only when the recent ids cover the last-seen marker", () => {
    const digest = {
      newestId: id("2026-11", 2),
      ids: [id("2026-10", 3), id("2026-11", 1), id("2026-11", 2)],
      idsComplete: false,
    };
    const seenAt = (seen: string) => ({ ...EMPTY_TOPIC_PREFERENCES, seen: { api: seen } });
    expect(unreadOf(seenAt(id("2026-10", 3)), "api", digest)).toEqual({ unread: true, count: 2 });
    expect(unreadOf(seenAt(id("2026-10", 1)), "api", digest)).toEqual({
      unread: true,
      count: null,
    });
    expect(unreadOf(EMPTY_TOPIC_PREFERENCES, "api", digest)).toEqual({ unread: true, count: null });
  });

  it("pages back through index/YYYY-MM.md on demand, one month at a time", async () => {
    const source = new FixtureSource(v2Repository());
    const session = new TopicSession(source);
    await session.open();
    const digest = await session.digest("api");
    const monthReads = () => source.reads.filter((path) => path.startsWith("topics/api/index/"));

    const first = await session.olderIndexRows("api", digest.ids?.[0] ?? "");
    expect(first?.month).toBe("2026-10");
    expect(first?.rows.map((r) => r.id)).toEqual([id("2026-10", 1), id("2026-10", 2)]);
    expect(monthReads()).toEqual(["topics/api/index/2026-10.md"]);

    const second = await session.olderIndexRows("api", id("2026-10", 1));
    expect(second?.month).toBe("2026-09");
    expect(second?.rows.map((r) => r.id)).toEqual([id("2026-09", 1), id("2026-09", 2)]);

    expect(await session.olderIndexRows("api", id("2026-09", 1))).toBeNull();
    // Asking again does not download a month file again.
    await session.olderIndexRows("api", id("2026-10", 3));
    expect(monthReads()).toEqual(["topics/api/index/2026-10.md", "topics/api/index/2026-09.md"]);
  });

  it("treats month files as untrusted: wrong-month rows dropped, oversized files skipped", async () => {
    const source = new FixtureSource(
      v2Repository({
        "topics/api/index/2026-10.md": table([...days("2026-10", [1]), ...days("2026-09", [2])]),
        "topics/api/index/2026-09.md": "x".repeat(3 * 1024 * 1024),
        "topics/api/index/notes.md": table(days("2026-08", [1])),
      }),
    );
    const session = new TopicSession(source);
    await session.open();
    const october = await session.olderIndexRows("api", id("2026-10", 3));
    expect(october?.rows.map((r) => r.id)).toEqual([id("2026-10", 1)]);
    expect(await session.olderIndexRows("api", id("2026-10", 1))).toBeNull();
    expect(source.reads).not.toContain("topics/api/index/2026-09.md");
    expect(source.reads).not.toContain("topics/api/index/notes.md");
    expect(await session.olderIndexRows("api", "../../x")).toBeNull();
  });

  it("skips a month file cut short by the row cap instead of serving it as complete", async () => {
    // 5001 valid October rows: one more than a generated file may hold.
    const rows = Array.from({ length: 5001 }, (_, n) => {
      const day = String(1 + Math.floor(n / 1440)).padStart(2, "0");
      const hour = String(Math.floor((n % 1440) / 60)).padStart(2, "0");
      const minute = String(n % 60).padStart(2, "0");
      return `| 2026-10-${day}T${hour}${minute}-alice-agent-api-01 | alice-agent | bob-agent | info | api |  | none | s |`;
    });
    const source = new FixtureSource(
      v2Repository({ "topics/api/index/2026-10.md": [HEADER, ...rows].join("\n") }),
    );
    const session = new TopicSession(source);
    await session.open();
    // October is skipped whole; paging moves on to September.
    const page = await session.olderIndexRows("api", id("2026-11", 1));
    expect(page?.month).toBe("2026-09");
    expect(page?.rows.map((r) => r.id)).toEqual([id("2026-09", 1), id("2026-09", 2)]);
  });
});

describe("a v1 repository", () => {
  it("keeps today's behaviour: index links ignored, no files listing, no month paging", async () => {
    const files = v2Repository({ ".agent-collab": V1 });
    const source = new FixtureSource(files);
    const session = new TopicSession(source);
    await session.open();
    expect(await session.digest("api")).toEqual({
      count: 3,
      newestId: id("2026-11", 2),
      fromIndex: true,
      ids: [id("2026-10", 3), id("2026-11", 1), id("2026-11", 2)],
    });
    expect(await session.files("api")).toBeNull();
    expect(await session.olderIndexRows("api", id("2026-10", 3))).toBeNull();
    expect(source.listings.filter((path) => /^topics\/api\/(files|index)/.test(path))).toEqual([]);
  });
});
