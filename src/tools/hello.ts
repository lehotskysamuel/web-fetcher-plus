import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ParameterNotFoundError } from "@aws-lambda-powertools/parameters/errors";
import { z } from "zod";
import { getSecret } from "../utils/aws.js";
import { BRIGHTDATA_API_KEY_NAME, BRIGHTDATA_ZONE_NAME } from "./fetchPage.js";

const CHECKED_PARAMETERS = [BRIGHTDATA_API_KEY_NAME, BRIGHTDATA_ZONE_NAME];

export function registerHello(server: McpServer) {
  server.registerTool(
    "hello",
    {
      title: "Hello",
      description:
        "Returns a greeting with the server time and region, and whether the Bright Data parameters can be read and decrypted (never their values). Use it to check that the connector works.",
      inputSchema: { name: z.string().optional().describe("Who to greet") },
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => ({
      content: [{ type: "text", text: await hello(name) }],
    }),
  );
}

export async function hello(name?: string): Promise<string> {
  const checks = await Promise.all(
    CHECKED_PARAMETERS.map(async (param) => `- ${param}: ${await checkParameter(param)}`),
  );
  return [
    `Hello, ${name || "world"}! Server time: ${new Date().toLocaleTimeString()}, region: Ireland.`,
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
  if (/\s/.test(value)) return "contains whitespace, check for a stray space or newline";
  return "ok";
}
