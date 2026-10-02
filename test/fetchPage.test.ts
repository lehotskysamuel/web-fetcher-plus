import { ParameterNotFoundError } from "@aws-lambda-powertools/parameters/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { truncate } from "../src/fetch/output.js";
import { fetchUnlocker, type Fetched } from "../src/fetch/unlocker.js";
import { fetchPage, type FetchPageArgs } from "../src/tools/fetchPage.js";
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
): Fetched => ({ status, contentType, markdown });

const run = (args: Partial<FetchPageArgs> = {}) =>
  fetchPage({
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
    await expect(run()).rejects.toMatchObject({ code: "UNLOCKER_ERROR" });

    secret.mockRejectedValue(new ParameterNotFoundError("missing"));
    await expect(run()).rejects.toMatchObject({ code: "UNLOCKER_ERROR" });
    expect(unlocker).not.toHaveBeenCalled();
  });

  it("reports the site's error statuses, blocks included, without retrying", async () => {
    for (const status of [403, 404, 503]) {
      unlocker.mockResolvedValueOnce(page("Forbidden", status));
      await expect(run()).rejects.toMatchObject({
        code: "HTTP_ERROR",
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

  it("rejects unsafe URLs before any request", async () => {
    await expect(run({ url: "http://169.254.169.254/" })).rejects.toMatchObject(
      { code: "SSRF_BLOCKED" },
    );
    await expect(
      run({ url: "https://example.com/?t=" + "a".repeat(80) }),
    ).rejects.toMatchObject({ code: "SUSPICIOUS_QUERY" });
    expect(unlocker).not.toHaveBeenCalled();
  });
});

describe("truncate", () => {
  it("cuts at a paragraph boundary", () => {
    const text = ["a".repeat(1500), "b".repeat(1500), "c".repeat(1500)].join(
      "\n\n",
    );
    const { text: out, truncated } = truncate(text, 4000);
    expect(truncated).toBe(true);
    expect(out).toBe(["a".repeat(1500), "b".repeat(1500)].join("\n\n"));
  });

  it("hard-cuts when there is no boundary in the second half", () => {
    const { text: out } = truncate("x".repeat(5000), 2000);
    expect(out.length).toBe(2000);
  });

  it("leaves short text alone", () => {
    expect(truncate("short", 500)).toEqual({ text: "short", truncated: false });
  });
});
