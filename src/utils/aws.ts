import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { getParameter } from "@aws-lambda-powertools/parameters/ssm";

/**
 * Reads the SSM parameter `SSM_PREFIX + name`, decrypted. Powertools caches found values for
 * 5 minutes; a missing parameter returns undefined and is looked up again on the next call.
 */
export async function getSecret(name: string): Promise<string> {
  const prefix = process.env.SSM_PREFIX;
  if (!prefix) throw new Error("SSM_PREFIX is not set");
  return await getParameter(prefix + name, {
    decrypt: true,
    maxAge: 5 * 60, // 5 mins
    throwOnMissing: true,
  });
}

export const lambdaResponse = (
  statusCode: number,
  body: string,
  headers: Record<string, string> = {},
): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  body,
});

/** `omitHeaders` are left out of the Request, e.g. to keep a secret away from the MCP SDK. */
export function apigwEventToRequest(
  event: APIGatewayProxyEventV2,
  omitHeaders: string[] = [],
): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers)) {
    if (value !== undefined && !omitHeaders.includes(key))
      headers.set(key, value);
  }
  if (event.cookies?.length) headers.set("cookie", event.cookies.join("; "));

  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `https://${event.requestContext.domainName}${event.rawPath}${query}`;
  const body =
    event.body === undefined
      ? undefined
      : event.isBase64Encoded
        ? Buffer.from(event.body, "base64")
        : event.body;

  return new Request(url, {
    method: event.requestContext.http.method,
    headers,
    body,
  });
}
