import { describe, expect, it } from "vitest";
import { hasDemoQuery } from "../src/ui/demo-query";

describe("demo query", () => {
  it.each([
    ["?demo", true],
    ["?demo=", true],
    ["?demo=yes", true],
    ["?other=1&demo=", true],
    ["", false],
    ["?other=demo", false],
  ])("parses %s", (search, expected) => {
    expect(hasDemoQuery(search)).toBe(expected);
  });
});
