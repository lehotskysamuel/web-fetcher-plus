import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { SSMClient } from "@aws-sdk/client-ssm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../src/config.js";
import { handler } from "../src/handler.js";

const PREFIX = "/aikiddo-mcp/test/";
const CURRENT = "c".repeat(64);
const PREVIOUS = "p".repeat(64);
let params: Record<string, string>;

function event(path: string, method = "POST"): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    rawQueryString: "",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    requestContext: { domainName: "example.lambda-url.eu-west-1.on.aws", http: { method } },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

const status = async (path: string, method?: string) => (await handler(event(path, method))).statusCode;

beforeEach(() => {
  process.env.SSM_PREFIX = PREFIX;
  params = {
    "url-secret": CURRENT,
    "url-secret-previous": PREVIOUS,
    "brightdata-api-key": "key",
    "brightdata-zone": "zone",
  };
  vi.spyOn(SSMClient.prototype, "send").mockImplementation(async (command: any) => ({
    Parameters: command.input.Names.filter((n: string) => params[n.slice(PREFIX.length)] !== undefined).map(
      (n: string) => ({ Name: n, Value: params[n.slice(PREFIX.length)] }),
    ),
  }));
  resetConfigCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("URL secret", () => {
  it("returns 404 for a wrong secret", async () => {
    expect(await status("/mcp/wrong")).toBe(404);
    expect(await status(`/mcp/${CURRENT}x`)).toBe(404);
  });

  it("returns 404 for a missing secret", async () => {
    expect(await status("/mcp")).toBe(404);
    expect(await status("/mcp/")).toBe(404);
  });

  it("accepts the current secret", async () => {
    expect(await status(`/mcp/${CURRENT}`)).toBe(200);
  });

  it("accepts the previous secret while it is set", async () => {
    expect(await status(`/mcp/${PREVIOUS}`)).toBe(200);
  });

  it("rejects the previous secret once it is deleted and the cache expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(await status(`/mcp/${PREVIOUS}`)).toBe(200);

    delete params["url-secret-previous"];
    expect(await status(`/mcp/${PREVIOUS}`)).toBe(200); // still cached

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(await status(`/mcp/${PREVIOUS}`)).toBe(404);
    expect(await status(`/mcp/${CURRENT}`)).toBe(200);
  });

  it("returns 404 rather than 405 for GET with a wrong secret", async () => {
    expect(await status("/mcp/wrong", "GET")).toBe(404);
    expect(await status(`/mcp/${CURRENT}`, "GET")).toBe(405);
  });

  it("keeps /healthz public", async () => {
    expect(await status("/healthz", "GET")).toBe(200);
  });

  it("returns 500 and logs only the parameter name when a required parameter is missing", async () => {
    delete params["brightdata-api-key"];
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handler(event(`/mcp/${CURRENT}`));
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe("internal error");
    expect(log).toHaveBeenCalledWith(`missing SSM parameter ${PREFIX}brightdata-api-key`);
    expect(JSON.stringify(log.mock.calls)).not.toContain(CURRENT);
  });
});
