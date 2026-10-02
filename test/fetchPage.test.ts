import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDirect, type Fetched } from "../src/fetch/http.js";
import { truncate } from "../src/fetch/output.js";
import { fetchUnlocker } from "../src/fetch/unlocker.js";
import { fetchPage, type FetchPageArgs } from "../src/tools/fetchPage.js";
import { getSecret } from "../src/utils/aws.js";

vi.mock("../src/fetch/http.js", async (original) => ({
  ...(await original()),
  fetchDirect: vi.fn(),
}));
vi.mock("../src/fetch/unlocker.js", () => ({ fetchUnlocker: vi.fn() }));
vi.mock("../src/utils/aws.js", () => ({ getSecret: vi.fn() }));

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const secrets: Record<string, string> = {
  "brightdata-api-key": "key",
  "brightdata-zone": "zone",
};
const URL_ = "https://kitchen.example/guides/sourdough";

const page = (
  html: string,
  status = 200,
  contentType = "text/html; charset=utf-8",
): Fetched => ({
  finalUrl: URL_,
  status,
  contentType,
  body: Buffer.from(html),
});

const run = (args: Partial<FetchPageArgs> = {}) =>
  fetchPage({
    url: URL_,
    include_frontmatter: true,
    extract_main_content: true,
    max_tokens: 20000,
    force_unlocker: false,
    ...args,
  });

const direct = vi.mocked(fetchDirect);
const unlocker = vi.mocked(fetchUnlocker);
const secret = vi.mocked(getSecret);

beforeEach(() => {
  vi.resetAllMocks();
  secret.mockImplementation(async (name) => secrets[name]);
});

describe("fetch_page", () => {
  it("returns front matter and the main content as Markdown", async () => {
    direct.mockResolvedValue(page(fixture("article.html")));
    const out = await run();

    expect(out).toMatch(
      /^---\nurl: https:\/\/kitchen\.example\/guides\/sourdough\n/,
    );
    expect(out).toContain("title: A Practical Guide to Sourdough\n");
    // Quoted because the value contains ": ".
    expect(out).toContain(
      'description: "How to bake sourdough bread at home: starter, hydration, fermentation and baking."\n',
    );
    expect(out).toContain("modified: 2026-07-20T11:07:47+00:00\n");
    expect(out).toContain(
      "status_code: 200\nfetched_via: direct\ntruncated: false\n",
    );
    expect(out).not.toContain("escalation_reason");
    expect(unlocker).not.toHaveBeenCalled();

    expect(out).toContain(
      "Bulk fermentation is where most of the flavour develops.",
    );
    expect(out).toContain(
      "[our rye variation](https://kitchen.example/recipes/rye)",
    );
    expect(out).toContain(
      "![A finished loaf](https://kitchen.example/images/loaf.jpg)",
    );
    expect(out).toMatch(/\| Step \| Time \|\n\| --- \| --- \|/);
    for (const noise of [
      "googletagmanager",
      "gtag",
      "Deutsch",
      "Privacy Policy",
      "Careers",
      "facebook.com/tr",
      "does not support the video",
      "youtube",
    ]) {
      expect(out).not.toContain(noise);
    }
  });

  it("keeps navigation and footer with extract_main_content: false", async () => {
    direct.mockResolvedValue(page(fixture("article.html")));
    const out = await run({ extract_main_content: false });
    expect(out).toContain("Privacy Policy");
    expect(out).toContain("Deutsch");
    expect(out).not.toContain("googletagmanager");
  });

  it("omits front matter when asked", async () => {
    direct.mockResolvedValue(page(fixture("article.html")));
    const out = await run({ include_frontmatter: false });
    expect(out).not.toContain("---\n");
    expect(
      out.startsWith("# A Practical Guide to Sourdough") ||
        out.startsWith("Sourdough bread"),
    ).toBe(true);
    expect(out).not.toContain("[... truncated");
  });

  it("truncates and flags it, in both output modes", async () => {
    const long = fixture("article.html").replace(
      "</article>",
      "<p>More notes on baking and timing.</p>".repeat(100) + "</article>",
    );
    direct.mockResolvedValue(page(long));
    const withMeta = await run({ max_tokens: 500 });
    expect(withMeta).toContain("truncated: true\n");
    const body = withMeta.split("---\n")[2]!;
    expect(body.length).toBeLessThanOrEqual(2000);

    const bare = await run({ max_tokens: 500, include_frontmatter: false });
    expect(bare).toMatch(/\n\n\[\.\.\. truncated at ~\d+ tokens\]$/);
  });

  it("escalates a blocked page to the Unlocker without rendering", async () => {
    direct.mockResolvedValue(page(fixture("cloudflare.html"), 403));
    unlocker.mockResolvedValue(page(fixture("article.html")));
    const out = await run();
    expect(unlocker).toHaveBeenCalledOnce();
    expect(unlocker.mock.calls[0]![1]).toMatchObject({
      apiKey: "key",
      zone: "zone",
      render: false,
    });
    expect(out).toContain(
      "fetched_via: unlocker\nescalation_reason: blocked:http_403\n",
    );
  });

  it("renders when the direct page is a JS shell", async () => {
    direct.mockResolvedValue(page(fixture("react-shell.html")));
    unlocker.mockResolvedValue(page(fixture("article.html")));
    const out = await run();
    expect(unlocker.mock.calls[0]![1]).toMatchObject({ render: true });
    expect(out).toContain("escalation_reason: js_shell\n");
  });

  it("skips the direct request with force_unlocker", async () => {
    unlocker.mockResolvedValue(page(fixture("article.html")));
    const out = await run({ force_unlocker: true });
    expect(direct).not.toHaveBeenCalled();
    expect(out).toContain("fetched_via: unlocker\nescalation_reason: forced\n");
  });

  it("errors when the Unlocker still gets a challenge", async () => {
    direct.mockResolvedValue(page(fixture("datadome.html")));
    unlocker.mockResolvedValue(page(fixture("datadome.html")));
    await expect(run()).rejects.toMatchObject({
      code: "BLOCKED_AFTER_UNLOCKER",
    });
  });

  it("explains when the Unlocker is needed but not configured", async () => {
    direct.mockResolvedValue(page(fixture("cloudflare.html"), 403));
    secret.mockResolvedValue("");
    await expect(run()).rejects.toMatchObject({ code: "UNLOCKER_ERROR" });
    expect(unlocker).not.toHaveBeenCalled();
  });

  it("reports HTTP errors without escalating", async () => {
    direct.mockResolvedValue(page("<h1>Not found</h1>", 404));
    await expect(run()).rejects.toMatchObject({ code: "HTTP_ERROR" });
    expect(unlocker).not.toHaveBeenCalled();
  });

  it("returns JSON as-is and refuses binary types", async () => {
    direct.mockResolvedValue(page('{"a": 1}', 200, "application/json"));
    expect(await run({ include_frontmatter: false })).toBe('{"a": 1}');

    direct.mockResolvedValue(page("\x89PNG\r\n\x1a\n\0\0", 200, "image/png"));
    await expect(run()).rejects.toMatchObject({
      code: "UNSUPPORTED_CONTENT_TYPE",
    });
  });

  it("rejects unsafe URLs before any request", async () => {
    await expect(run({ url: "http://169.254.169.254/" })).rejects.toMatchObject(
      { code: "SSRF_BLOCKED" },
    );
    await expect(
      run({ url: "https://example.com/?t=" + "a".repeat(80) }),
    ).rejects.toMatchObject({ code: "SUSPICIOUS_QUERY" });
    expect(direct).not.toHaveBeenCalled();
    expect(unlocker).not.toHaveBeenCalled();
  });
});

describe("truncate", () => {
  it("cuts at a paragraph boundary", () => {
    const text = ["a".repeat(1500), "b".repeat(1500), "c".repeat(1500)].join(
      "\n\n",
    );
    const { text: out, truncated } = truncate(text, 1000); // 4000 chars
    expect(truncated).toBe(true);
    expect(out).toBe(["a".repeat(1500), "b".repeat(1500)].join("\n\n"));
  });

  it("hard-cuts when there is no boundary in the second half", () => {
    const { text: out } = truncate("x".repeat(5000), 500);
    expect(out.length).toBe(2000);
  });

  it("leaves short text alone", () => {
    expect(truncate("short", 500)).toEqual({ text: "short", truncated: false });
  });
});
