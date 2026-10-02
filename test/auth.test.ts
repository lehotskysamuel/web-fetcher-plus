import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { clearCaches } from "@aws-lambda-powertools/parameters";
import { ParameterNotFound, SSMClient } from "@aws-sdk/client-ssm";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../src/handler.js";

const PREFIX = "/aikiddo-mcp/test/";
const SECRET = "c".repeat(64);
let params: Record<string, string>;

function event(path: string, authorization?: string, method = "POST"): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    rawQueryString: "",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(authorization !== undefined && { authorization }),
    },
    requestContext: { domainName: "example.lambda-url.eu-west-1.on.aws", http: { method } },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

const BEARER = `Bearer ${SECRET}`;

const status = async (path: string, authorization?: string, method?: string) =>
  (await handler(event(path, authorization, method))).statusCode;

beforeEach(() => {
  process.env.SSM_PREFIX = PREFIX;
  params = {
    "mcp-secret": SECRET,
    "brightdata-api-key": "key",
    "brightdata-zone": "zone",
  };
  vi.spyOn(SSMClient.prototype, "send").mockImplementation(async (command: any) => {
    const name: string = command.input.Name;
    const value = params[name.slice(PREFIX.length)];
    if (value === undefined) throw new ParameterNotFound({ message: name, $metadata: {} });
    return { Parameter: { Name: name, Value: value } };
  });
  clearCaches();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Bearer token", () => {
  it("accepts the secret as a bearer token", async () => {
    expect(await status("/mcp", BEARER)).toBe(200);
    expect(await status("/mcp", `bearer ${SECRET}`)).toBe(200);
  });

  it("returns 401 for a wrong secret", async () => {
    expect(await status("/mcp", "Bearer wrong")).toBe(401);
    expect(await status("/mcp", `Bearer ${SECRET}x`)).toBe(401);
  });

  it("returns 401 for the secret without the Bearer scheme", async () => {
    expect(await status("/mcp", SECRET)).toBe(401);
    expect(await status("/mcp", `Basic ${SECRET}`)).toBe(401);
    expect(await status("/mcp", `Bearer${SECRET}`)).toBe(401);
  });

  it("returns 401 for a missing or empty secret", async () => {
    expect(await status("/mcp")).toBe(401);
    expect(await status("/mcp", "")).toBe(401);
    expect(await status("/mcp", "Bearer ")).toBe(401);
  });

  it("returns 404 for other paths, even with the secret", async () => {
    expect(await status("/mcp/", BEARER)).toBe(404);
    expect(await status(`/mcp/${SECRET}`, BEARER)).toBe(404);
    expect(await status("/other", BEARER)).toBe(404);
  });

  it("returns 401 rather than 405 for GET without the secret", async () => {
    expect(await status("/mcp", "Bearer wrong", "GET")).toBe(401);
    expect(await status("/mcp", BEARER, "GET")).toBe(405);
  });

  it("keeps the Authorization header away from the MCP SDK", async () => {
    const handle = vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, "handleRequest");
    expect(await status("/mcp", BEARER)).toBe(200);
    const request = handle.mock.calls[0][0];
    expect(request.headers.has("authorization")).toBe(false);
    expect(new URL(request.url).pathname).toBe("/mcp");
  });

  it("keeps /healthz public", async () => {
    expect(await status("/healthz", undefined, "GET")).toBe(200);
  });

  it("works without the Bright Data parameters", async () => {
    delete params["brightdata-api-key"];
    delete params["brightdata-zone"];
    expect(await status("/mcp", BEARER)).toBe(200);
  });

  it("returns 500 and logs only the parameter name when the secret is missing", async () => {
    delete params["mcp-secret"];
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handler(event("/mcp", BEARER));
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe("internal error");
    expect(log.mock.calls[0][0]).toBe("failed to load SSM parameter mcp-secret");
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
  });
});
