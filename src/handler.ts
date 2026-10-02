import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerHello } from "./tools/hello.js";

type Result = APIGatewayProxyStructuredResultV2;

const text = (statusCode: number, body: string, headers: Record<string, string> = {}): Result => ({
  statusCode,
  headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  body,
});

export async function handler(event: APIGatewayProxyEventV2): Promise<Result> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  if (path === "/healthz" && (method === "GET" || method === "HEAD")) return text(200, "ok");
  if (path !== "/mcp") return text(404, "not found");
  // Stateless JSON mode: no standalone SSE stream (GET) and no sessions to end (DELETE).
  if (method !== "POST") return text(405, "method not allowed", { allow: "POST" });

  return handleMcp(event);
}

async function handleMcp(event: APIGatewayProxyEventV2): Promise<Result> {
  // Stateless mode needs a fresh server and transport per request.
  const server = new McpServer({ name: "aikiddo-mcp", version: "0.1.0" });
  registerHello(server);
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

  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `https://${event.requestContext.domainName}${event.rawPath}${query}`;
  const body =
    event.body === undefined ? undefined : event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;

  return new Request(url, { method: event.requestContext.http.method, headers, body });
}
