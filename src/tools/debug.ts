import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ParameterNotFoundError } from "@aws-lambda-powertools/parameters/errors";
import { getSecret } from "../utils/aws.js";
import { BRIGHTDATA_API_KEY_NAME, BRIGHTDATA_ZONE_NAME } from "./fetchBlockedPage.js";

const CHECKED_PARAMETERS = [BRIGHTDATA_API_KEY_NAME, BRIGHTDATA_ZONE_NAME];

export function registerDebug(server: McpServer) {
  server.registerTool(
    "debug",
    {
      title: "Debug",
      description:
        "Reports diagnostic information about this server: the server time and region, and whether the SSM parameters can be read and decrypted (never their values). Use it to check that the connector works and is configured.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [{ type: "text", text: await debug() }],
    }),
  );
}

export async function debug(): Promise<string> {
  const checks = await Promise.all(
    CHECKED_PARAMETERS.map(
      async (param) => `- ${param}: ${await checkParameter(param)}`,
    ),
  );
  return [
    `Server time: ${new Date().toLocaleTimeString()}, region: Ireland.`,
    "",
    "Bright Data parameters:",
    ...checks,
  ].join("\n");
}

/** Reads and decrypts one parameter and describes its state. Never returns or logs the value. */
export async function checkParameter(param: string): Promise<string> {
  let value: string;
  try {
    value = await getSecret(param);
  } catch (err) {
    if (err instanceof ParameterNotFoundError) return "missing";
    // Report only the error name: AWS messages name the parameter and key, not the value.
    const cause = (err as Error)?.cause as Error | undefined;
    console.error(`failed to load SSM parameter ${param}`, err);
    return `unreadable (${cause?.name ?? (err as Error)?.name ?? "unknown error"})`;
  }
  if (!value) return "empty";
  if (/\s/.test(value))
    return "contains whitespace, check for a stray space or newline";
  return "ok";
}
