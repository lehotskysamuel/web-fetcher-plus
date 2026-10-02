import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { createHash, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerFetchBlockedPage } from "./tools/fetchBlockedPage.js";
import { registerDebug } from "./tools/debug.js";
import { apigwEventToRequest, getSecret, lambdaResponse } from "./utils/aws.js";

const MCP_SECRET_NAME = "mcp-secret";

const AUTH_HEADER = "authorization"; // Function URLs lowercase header names.

// Never log the headers or the event: the Authorization header holds the MCP secret.
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  if (path === "/healthz" && (method === "GET" || method === "HEAD")) {
    return lambdaResponse(200, "ok");
  }
  if (path !== "/mcp") {
    return lambdaResponse(404, "not found");
  }

  let mcpSecret: string;
  try {
    mcpSecret = await getSecret(MCP_SECRET_NAME);
  } catch (err) {
    console.error(`failed to load SSM parameter ${MCP_SECRET_NAME}`, err);
    return lambdaResponse(500, "internal error");
  }
  if (!mcpSecret) {
    // Name the parameter, never its value.
    console.error(`missing SSM parameter ${MCP_SECRET_NAME}`);
    return lambdaResponse(500, "internal error");
  }

  const candidate = bearerToken(event.headers[AUTH_HEADER]);
  if (!isValidMcpSecret(candidate, mcpSecret))
    return lambdaResponse(401, "missing mcp secret");

  // Stateless JSON mode: no standalone SSE stream (GET) and no sessions to end (DELETE).
  if (method !== "POST")
    return lambdaResponse(405, "method not allowed", { allow: "POST" });

  return handleMcp(event);
}

function bearerToken(header: string | undefined): string {
  // `Authorization: Bearer <token>`; the scheme is case-insensitive (RFC 7235).
  const match = /^Bearer +(\S+) *$/i.exec(header ?? "");
  return match?.[1] ?? "";
}

function isValidMcpSecret(candidate: string, mcpSecret: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  const candidateDigest = digest(candidate);
  const mcpSecretDigest = digest(mcpSecret);
  const matchesCurrent = timingSafeEqual(candidateDigest, mcpSecretDigest);
  return candidate !== "" && matchesCurrent;
}

async function handleMcp(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  // Stateless mode needs a fresh server and transport per request.
  const server = new McpServer({ name: "aikiddo-mcp", version: "0.1.0" });
  registerDebug(server);
  registerFetchBlockedPage(server);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);

  try {
    const response = await transport.handleRequest(
      apigwEventToRequest(event, [AUTH_HEADER]),
    );
    return {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    };
  } finally {
    await server.close();
  }
}
