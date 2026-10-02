import { fetch } from "undici";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUnlocker, MAX_BYTES } from "../src/fetch/unlocker.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));

const api = vi.mocked(fetch);
const URL_ = new URL("https://kitchen.example/guides/sourdough");
const opts = () => ({ apiKey: "key", zone: "zone", deadline: Date.now() + 60_000 });

const respond = (body: BodyInit, status: number, headers: Record<string, string>) =>
  api.mockResolvedValueOnce(new Response(body, { status, headers }) as never);

beforeEach(() => vi.resetAllMocks());

describe("fetchUnlocker", () => {
  it("asks for Markdown and returns it with the site's status and type", async () => {
    respond("# Sourdough\n\nCrème fraîche optional.", 200, { "x-brd-status-code": "200", "content-type": "text/html; charset=UTF-8" });

    const out = await fetchUnlocker(URL_, opts());
    expect(out).toEqual({ status: 200, contentType: "text/html; charset=UTF-8", markdown: "# Sourdough\n\nCrème fraîche optional." });

    const [endpoint, init] = api.mock.calls[0]!;
    expect(endpoint).toBe("https://api.brightdata.com/request");
    expect(init!.headers).toMatchObject({ authorization: "Bearer key" });
    expect(JSON.parse(init!.body as string)).toEqual({ zone: "zone", url: URL_.href, format: "raw", data_format: "markdown" });
  });

  it("passes a site's error status through instead of treating it as Bright Data's", async () => {
    respond("# Not found", 404, { "x-brd-status-code": "404", "content-type": "text/html" });
    expect(await fetchUnlocker(URL_, opts())).toMatchObject({ status: 404 });
  });

  it("reports Bright Data's own 4xx with its reason, without retrying", async () => {
    respond('zone "web_unlocker1" not found', 400, {});
    await expect(fetchUnlocker(URL_, opts())).rejects.toMatchObject({
      code: "UNLOCKER_ERROR",
      message: expect.stringContaining('HTTP 400: zone "web_unlocker1" not found'),
    });

    respond("", 403, { "x-brd-error": "Forbidden: target site requires special permission" });
    await expect(fetchUnlocker(URL_, opts())).rejects.toThrow(/requires special permission/);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("retries once on a 5xx from Bright Data", async () => {
    respond("busy", 502, {});
    respond("ok", 200, { "x-brd-status-code": "200", "content-type": "text/html" });
    expect(await fetchUnlocker(URL_, opts())).toMatchObject({ status: 200 });
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("refuses responses over the size cap", async () => {
    respond("x", 200, { "x-brd-status-code": "200", "content-length": String(MAX_BYTES + 1) });
    await expect(fetchUnlocker(URL_, opts())).rejects.toMatchObject({ code: "TOO_LARGE" });
  });
});
