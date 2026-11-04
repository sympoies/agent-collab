// Plain text from untrusted cells (generated files, TOPIC.md): nothing hidden, nothing clickable.

const MAX_CELL = 200;

// Control characters, bidirectional overrides and isolates, zero-width and byte-order characters.
const HIDDEN = new RegExp(
  // eslint-disable-next-line no-control-regex
  "[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]",
  "g",
);

/** Plain text of a cell: hidden characters dropped, a markdown link reduced to its label. */
export function plainText(value: string, limit = MAX_CELL): string {
  const link = /^\[([^\]]*)\]\(.*\)$/.exec(value.trim());
  return (link?.[1] ?? value)
    .replace(/[\t\n\r]+/g, " ")
    .replace(HIDDEN, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}
