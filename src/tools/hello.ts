import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerHello(server: McpServer) {
  server.registerTool(
    "hello",
    {
      title: "Hello",
      description: "Returns a greeting with the server time and region. Use it to check that the connector works.",
      inputSchema: { name: z.string().optional().describe("Who to greet") },
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => ({
      content: [
        {
          type: "text",
          text: `Hello, ${name || "world"}! Server time: ${new Date().toISOString()}, region: Ireland.`,
        },
      ],
    }),
  );
}
