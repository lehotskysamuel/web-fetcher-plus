import { beforeEach, describe, expect, it, vi } from "vitest";
import { ATTEMPT_MS, fetchUnlocker, maxBytes } from "../src/fetch/unlocker.js";

const api = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", api);
const URL_ = new URL("https://kitchen.example/guides/sourdough");
const opts = () => ({ apiKey: "key", zone: "zone" });

const respond = (body: BodyInit, status: number, headers: Record<string, string>) =>
  api.mockResolvedValueOnce(new Response(body, { status, headers }) as never);

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("fetchUnlocker", () => {
  it("asks for Markdown and returns it with the site's status and type", async () => {
    respond("# Sourdough\n\nCrème fraîche optional.", 200, { "x-brd-status-code": "200", "content-type": "text/html; charset=UTF-8" });

    const out = await fetchUnlocker(URL_, opts());
    expect(out).toEqual({
      status: 200,
      contentType: "text/html; charset=UTF-8",
      markdown: "# Sourdough\n\nCrème fraîche optional.",
      complete: true,
    });

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
      code: "INTERNAL_ERROR",
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

  it("retries once on a timeout, then gives up", async () => {
    const timeout = () => api.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    timeout();
    respond("ok", 200, { "x-brd-status-code": "200", "content-type": "text/html" });
    expect(await fetchUnlocker(URL_, opts())).toMatchObject({ status: 200 });

    timeout();
    timeout();
    await expect(fetchUnlocker(URL_, opts())).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: expect.stringContaining(`failed twice (no answer within ${ATTEMPT_MS / 1000} s)`),
    });
    expect(api).toHaveBeenCalledTimes(4);
  });

  it("doesn't retry unexpected errors", async () => {
    api.mockResolvedValueOnce({} as never); // no headers: a TypeError, not a Bright Data failure
    await expect(fetchUnlocker(URL_, opts())).rejects.toThrow(TypeError);
    expect(api).toHaveBeenCalledOnce();
  });

  it("gives each attempt its own 35 s timeout", async () => {
    respond("ok", 200, { "x-brd-status-code": "200", "content-type": "text/html" });
    const spy = vi.spyOn(AbortSignal, "timeout");
    await fetchUnlocker(URL_, opts());
    expect(spy).toHaveBeenCalledWith(35_000);
    spy.mockRestore();
  });

  it("caps the body at an eighth of the Lambda's memory", async () => {
    expect(maxBytes()).toBe(128 * 1024 * 1024); // the 1024 MB default
    vi.stubEnv("AWS_LAMBDA_FUNCTION_MEMORY_SIZE", "8"); // 1 MB cap

    let pulls = 0;
    const endless = new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode("x".repeat(256 * 1024)));
      },
    });
    respond(endless, 200, { "x-brd-status-code": "200", "content-type": "text/html" });
    const out = await fetchUnlocker(URL_, opts());
    expect(out.markdown.length).toBe(1024 * 1024);
    expect(out.complete).toBe(false);
    expect(pulls).toBeLessThan(10);
  });


});
