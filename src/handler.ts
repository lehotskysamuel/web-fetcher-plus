import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { createHash, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ConfigError, getConfig, type Config } from "./config.js";
import { registerFetchPage } from "./tools/fetchPage.js";

type Result = APIGatewayProxyStructuredResultV2;

const text = (statusCode: number, body: string, headers: Record<string, string> = {}): Result => ({
  statusCode,
  headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  body,
});

const MCP_PREFIX = "/mcp/";

// Never log the request path or the event: the path contains the URL secret.
export async function handler(event: APIGatewayProxyEventV2): Promise<Result> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  if (path === "/healthz" && (method === "GET" || method === "HEAD")) return text(200, "ok");
  if (!path.startsWith(MCP_PREFIX)) return text(404, "not found");

  let config: Config;
  try {
    config = await getConfig();
  } catch (err) {
    // ConfigError messages name the parameter, never its value.
    if (err instanceof ConfigError) console.error(err.message);
    else console.error("failed to load config", err);
    return text(500, "internal error");
  }

  // A wrong or missing secret looks exactly like an unknown path.
  if (!isValidSecret(path.slice(MCP_PREFIX.length), config)) return text(404, "not found");
  // Stateless JSON mode: no standalone SSE stream (GET) and no sessions to end (DELETE).
  if (method !== "POST") return text(405, "method not allowed", { allow: "POST" });

  return handleMcp(event, config);
}

function isValidSecret(candidate: string, config: Config): boolean {
  // Compare fixed-length digests so neither the content nor the length of the secret leaks through timing.
  const digest = (s: string) => createHash("sha256").update(s).digest();
  const given = digest(candidate);
  const matchesCurrent = timingSafeEqual(given, digest(config.urlSecret));
  const matchesPrevious = timingSafeEqual(given, digest(config.urlSecretPrevious ?? ""));
  return candidate !== "" && (matchesCurrent || (config.urlSecretPrevious !== undefined && matchesPrevious));
}

async function handleMcp(event: APIGatewayProxyEventV2, config: Config): Promise<Result> {
  // Stateless mode needs a fresh server and transport per request.
  const server = new McpServer({ name: "aikiddo-mcp", version: "0.1.0" });
  registerFetchPage(server, config);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);

  try {
    const response = await transport.handleRequest(toRequest(event));
    return {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    };
  } finally {
    await server.close();
  }
}

function toRequest(event: APIGatewayProxyEventV2): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers)) {
    if (value !== undefined) headers.set(key, value);
  }
  if (event.cookies?.length) headers.set("cookie", event.cookies.join("; "));

  // Keep the secret out of the SDK: it only ever sees /mcp.
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `https://${event.requestContext.domainName}/mcp${query}`;
  const body =
    event.body === undefined ? undefined : event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;

  return new Request(url, { method: event.requestContext.http.method, headers, body });
}
