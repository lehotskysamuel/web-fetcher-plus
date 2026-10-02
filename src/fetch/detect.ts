// Pure functions that classify a fetched HTML page. Regex-based on purpose: they run on every
// direct fetch and must stay cheap.

const BLOCK_STATUSES = new Set([401, 403, 429, 503]);

const BLOCK_MARKERS = [
  "Just a moment...",
  "cf-chl",
  "challenge-platform",
  "cf-turnstile",
  "g-recaptcha",
  "h-captcha",
  "px-captcha",
  "_Incapsula_Resource",
  "datadome",
  "Pardon Our Interruption",
  "verify you are human",
];

// Challenge and block pages are tiny. Normal pages also embed reCAPTCHA, DataDome tags or talk about
// "verify you are human", so a marker only counts when there is little visible text, or when it is the title.
const CHALLENGE_MAX_TEXT = 2000;

export type Detection = { blocked: string } | { jsShell: true } | null;

export function visibleText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleOf(html: string): string {
  return /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
}

/** The block marker or status that identifies a bot-protection page, or undefined. */
export function detectBlock(status: number, html: string): string | undefined {
  if (BLOCK_STATUSES.has(status)) return `http_${status}`;

  const lower = html.toLowerCase();
  const title = titleOf(html).toLowerCase();
  const short = visibleText(html).length < CHALLENGE_MAX_TEXT;
  for (const marker of BLOCK_MARKERS) {
    const m = marker.toLowerCase();
    if (title.includes(m) || (short && lower.includes(m))) return marker;
  }
  return undefined;
}

/** True if the page needs JavaScript to show its content. */
export function isJsShell(html: string): boolean {
  const textLength = visibleText(html).length;
  if (/enable javascript/i.test(html) && textLength < 1000) return true;
  return textLength < 500 && html.length > 20_000 && hasEmptyAppRoot(html);
}

function hasEmptyAppRoot(html: string): boolean {
  return /<div[^>]*\bid=["'](root|app|__next)["'][^>]*>\s*<\/div>/i.test(html);
}

export function detect(status: number, html: string): Detection {
  const blocked = detectBlock(status, html);
  if (blocked) return { blocked };
  return isJsShell(html) ? { jsShell: true } : null;
}
