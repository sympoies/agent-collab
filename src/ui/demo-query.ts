/** A query parameter, independent of message hashes, selects the demo for this visit. */
export function hasDemoQuery(search: string): boolean {
  return new URLSearchParams(search).has("demo");
}
