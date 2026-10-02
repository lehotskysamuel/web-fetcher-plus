/**
 * How far back from the limit a cut may move to land on a boundary: this for a paragraph, twice this for a line.
 * Shorter limits use 25% and 50% of the limit instead, so a cut never gives up more than half of it.
 */
export const BOUNDARY_WINDOW = 20_000;

/** Cuts text to at most maxChars, preferring a paragraph boundary, then a line boundary. */
export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };

  const head = text.slice(0, maxChars);
  const paragraph = head.lastIndexOf("\n\n");
  const line = head.lastIndexOf("\n");
  const cut =
    paragraph >= maxChars - Math.min(BOUNDARY_WINDOW, maxChars * 0.25)
      ? paragraph
      : line >= maxChars - Math.min(2 * BOUNDARY_WINDOW, maxChars * 0.5)
        ? line
        : maxChars;
  return { text: head.slice(0, cut).trimEnd(), truncated: true };
}
