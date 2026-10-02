import { ParameterNotFoundError } from "@aws-lambda-powertools/parameters/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BOUNDARY_WINDOW, truncate } from "../src/fetch/output.js";
import { fetchUnlocker, type Fetched } from "../src/fetch/unlocker.js";
import {
  fetchBlockedPage,
  type FetchBlockedPageArgs,
} from "../src/tools/fetchBlockedPage.js";
import { getSecret } from "../src/utils/aws.js";

vi.mock("../src/fetch/unlocker.js", () => ({ fetchUnlocker: vi.fn() }));
vi.mock("../src/utils/aws.js", () => ({ getSecret: vi.fn() }));

const secrets: Record<string, string> = {
  "brightdata-api-key": "key",
  "brightdata-zone": "zone",
};
const URL_ = "https://kitchen.example/guides/sourdough";

// Shaped like Bright Data's Markdown: the page title first, navigation included.
const ARTICLE = `A Practical Guide to Sourdough | Kitchen

[Recipes](https://kitchen.example/recipes) [Guides](/guides)

# A Practical Guide to Sourdough

Sourdough bread needs only flour, water and salt, plus a healthy starter and patience.

Bulk fermentation is where most of the flavour develops. Keep the dough warm and fold it every half hour.

| Step | Time |
| --- | --- |
| Bulk | 4 h |
| Proof | 12 h |

Try [our rye variation](https://kitchen.example/recipes/rye) next.`;

const CHALLENGE = `Just a moment...

www.example.com

## Verifying you are human. This may take a few seconds.

www.example.com needs to review the security of your connection before proceeding.`;

const page = (
  markdown: string,
  status = 200,
  contentType = "text/html; charset=utf-8",
  complete = true,
): Fetched => ({ status, contentType, markdown, complete });

const run = (args: Partial<FetchBlockedPageArgs> = {}) =>
  fetchBlockedPage({
    url: URL_,
    max_chars: 80000,
    ...args,
  });

const unlocker = vi.mocked(fetchUnlocker);
const secret = vi.mocked(getSecret);

beforeEach(() => {
  vi.resetAllMocks();
  secret.mockImplementation(async (name) => secrets[name]!);
});

describe("fetch_blocked_page", () => {
  it("returns Bright Data's Markdown as-is", async () => {
    unlocker.mockResolvedValue(page(ARTICLE));
    expect(await run()).toBe(ARTICLE);
    expect(unlocker).toHaveBeenCalledOnce();
    expect(unlocker.mock.calls[0]![0].href).toBe(URL_);
    expect(unlocker.mock.calls[0]![1]).toMatchObject({
      apiKey: "key",
      zone: "zone",
    });
  });

  it("cuts long pages to max_chars and says how much is missing", async () => {
    const long = ARTICLE + "\n\nMore notes on baking and timing.".repeat(100);
    unlocker.mockResolvedValue(page(long));
    const out = await run({ max_chars: 2000 });
    const [body, note] = out.split("\n\n[... truncated: ");
    expect(body!.length).toBeLessThanOrEqual(2000);
    expect(note).toBe(`showing ${body!.length} of ${long.length} characters]`);
  });

  it("says the page is longer when reading stopped at the memory cap", async () => {
    unlocker.mockResolvedValue(page(ARTICLE, 200, "text/html", false));
    expect(await run()).toBe(
      `${ARTICLE}\n\n[... truncated: showing ${ARTICLE.length} characters; the page is longer]`,
    );
  });

  it("returns JSON as-is", async () => {
    unlocker.mockResolvedValue(page('{"a": 1}', 200, "application/json"));
    expect(await run()).toBe('{"a": 1}');
    expect(unlocker).toHaveBeenCalledOnce();
  });

  it("returns a challenge page as-is; Bright Data decides what is blocked", async () => {
    unlocker.mockResolvedValue(page(CHALLENGE));
    expect(await run()).toBe(CHALLENGE);
  });

  it("explains when Bright Data isn't configured, without a request", async () => {
    secret.mockResolvedValue("");
    await expect(run()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    secret.mockRejectedValue(new ParameterNotFoundError("missing"));
    await expect(run()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(unlocker).not.toHaveBeenCalled();
  });

  it("reports the site's error statuses, blocks included, without retrying", async () => {
    for (const status of [403, 404, 503]) {
      unlocker.mockResolvedValueOnce(page("Forbidden", status));
      await expect(run()).rejects.toMatchObject({
        code: "URL_NOT_ACCESSIBLE",
        message: expect.stringContaining(`HTTP ${status}`),
      });
    }
    expect(unlocker).toHaveBeenCalledTimes(3);
  });

  it("refuses a .pdf URL before paying for a request", async () => {
    await expect(
      run({ url: "https://kitchen.example/menu.PDF" }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_CONTENT_TYPE",
      message: expect.stringContaining("built-in web fetch"),
    });
    expect(secret).not.toHaveBeenCalled();
    expect(unlocker).not.toHaveBeenCalled();
  });

  it("refuses PDFs and other binary types by their Content-Type", async () => {
    unlocker.mockResolvedValue(
      page("%PDF-1.4 garbage", 200, "application/pdf; qs=0.001"),
    );
    await expect(run()).rejects.toThrow(/This is a PDF/);

    unlocker.mockResolvedValue(page("\x89PNG", 200, "image/png"));
    await expect(run()).rejects.toMatchObject({
      code: "UNSUPPORTED_CONTENT_TYPE",
      message: expect.stringContaining("image/png"),
    });
  });

  it("rejects local hosts and blocklisted domains before any request", async () => {
    await expect(run({ url: "http://169.254.169.254/" })).rejects.toMatchObject(
      { code: "URL_NOT_ALLOWED" },
    );
    await expect(
      run({ url: "https://www.linkedin.com/in/someone" }),
    ).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
    expect(unlocker).not.toHaveBeenCalled();
  });
});

describe("truncate", () => {
  const LIMIT = 80_000;
  // `x` filler with the given separators at the given positions.
  const filler = (length: number, breaks: [number, string][]) => {
    let text = "x".repeat(length);
    for (const [at, sep] of breaks)
      text = text.slice(0, at) + sep + text.slice(at + sep.length);
    return text;
  };

  it("cuts at the last paragraph break within BOUNDARY_WINDOW of the limit", () => {
    const at = LIMIT - BOUNDARY_WINDOW + 10;
    const { text, truncated } = truncate(
      filler(100_000, [[at, "\n\n"]]),
      LIMIT,
    );
    expect(truncated).toBe(true);
    expect(text.length).toBe(at);
  });

  it("falls back to a line break within twice BOUNDARY_WINDOW", () => {
    const paragraphAt = LIMIT - 3 * BOUNDARY_WINDOW;
    const lineAt = LIMIT - 2 * BOUNDARY_WINDOW + 10;
    const text = filler(100_000, [
      [paragraphAt, "\n\n"],
      [lineAt, "\n"],
    ]);
    expect(truncate(text, LIMIT).text.length).toBe(lineAt);
  });

  it("hard-cuts at the limit when no boundary is close enough", () => {
    const text = filler(100_000, [[LIMIT - 2 * BOUNDARY_WINDOW - 10, "\n\n"]]);
    expect(truncate(text, LIMIT).text.length).toBe(LIMIT);
    expect(truncate("x".repeat(5000), 2000).text.length).toBe(2000);
  });

  it("uses 25% and 50% of a limit under 20k characters", () => {
    // 2000: paragraph from 1500, line from 1000.
    expect(truncate(filler(5000, [[1600, "\n\n"]]), 2000).text.length).toBe(
      1600,
    );
    // Paragraph at 1100 is outside its 25% window; the line break at 1200 is inside its 50% one.
    const text = filler(5000, [
      [1100, "\n\n"],
      [1200, "\n"],
    ]);
    expect(truncate(text, 2000).text.length).toBe(1200);
    expect(truncate(filler(5000, [[50, "\n\n"]]), 2000).text.length).toBe(2000);
  });

  it("never gives up more than half the limit between 20k and 80k", () => {
    // 30000: paragraph from 22500, line from 15000.
    expect(truncate(filler(50_000, [[5, "\n"]]), 30_000).text.length).toBe(
      30_000,
    );
    expect(truncate(filler(50_000, [[16_000, "\n"]]), 30_000).text.length).toBe(
      16_000,
    );
  });

  it("leaves short text alone", () => {
    expect(truncate("short", 500)).toEqual({ text: "short", truncated: false });
  });
});
