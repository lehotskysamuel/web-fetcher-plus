const CHARS_PER_TOKEN = 4;

export const approxTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

/** Cuts text to about maxTokens, preferring a paragraph boundary, then a line boundary. */
export function truncate(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const limit = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= limit) return { text, truncated: false };

  const head = text.slice(0, limit);
  // Only back off to a boundary if that keeps at least half the budget.
  const floor = limit / 2;
  const paragraph = head.lastIndexOf("\n\n");
  const line = head.lastIndexOf("\n");
  const cut = paragraph >= floor ? paragraph : line >= floor ? line : limit;
  return { text: head.slice(0, cut).trimEnd(), truncated: true };
}

export type FrontMatter = Record<string, string | number | boolean | undefined>;

/** A YAML front matter block. Empty values are omitted. */
export function frontMatter(fields: FrontMatter): string {
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${yamlScalar(value!)}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

function yamlScalar(value: string | number | boolean): string {
  if (typeof value !== "string") return String(value);
  const plain =
    /^[^\s\-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
    !/: |\s#|[\n\r\t]|\s$/.test(value) &&
    !value.endsWith(":") &&
    !/^(true|false|yes|no|on|off|null|~|[-+]?(\d[\d_]*)?\.?\d+([eE][-+]?\d+)?)$/i.test(value);
  // JSON strings are valid YAML double-quoted scalars.
  return plain ? value : JSON.stringify(value);
}
