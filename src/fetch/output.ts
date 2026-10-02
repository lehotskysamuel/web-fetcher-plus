/** Cuts text to at most maxChars, preferring a paragraph boundary, then a line boundary. */
export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };

  const head = text.slice(0, maxChars);
  // Only back off to a boundary if that keeps at least half the budget.
  const floor = maxChars / 2;
  const paragraph = head.lastIndexOf("\n\n");
  const line = head.lastIndexOf("\n");
  const cut = paragraph >= floor ? paragraph : line >= floor ? line : maxChars;
  return { text: head.slice(0, cut).trimEnd(), truncated: true };
}
