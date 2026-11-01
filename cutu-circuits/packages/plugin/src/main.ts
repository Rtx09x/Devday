import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createToolRegistry } from "./registry.ts";
import { z } from "zod";
import { BrokerClient, BrokerError, projectPath } from "./client.ts";

const broker = new BrokerClient();
const server = new McpServer({ name: "cutucircuits", version: "0.1.0" });
const register = (
  name: string,
  description: string,
  schema: z.ZodRawShape,
  handler: (input: any) => Promise<unknown>,
  readOnly = false,
) => {
  server.registerTool(
    name,
    {
      description,
      inputSchema: schema,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: !readOnly,
        idempotentHint: readOnly,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const result = await handler(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        const detail =
          error instanceof BrokerError
            ? {
                code: error.code,
                message: error.message,
                ...(error.status ? { status: error.status } : {}),
              }
            : {
                code: "TOOL_ERROR",
                message: error instanceof Error ? error.message : String(error),
              };
        return {
          isError: true,
          content: [
            { type: "text" as const, text: JSON.stringify({ error: detail }) },
          ],
        };
      }
    },
  );
};
for (const tool of createToolRegistry(broker))
  register(
    tool.name,
    tool.description,
    tool.schema.shape,
    tool.handler,
    tool.readOnly,
  );

await server.connect(new StdioServerTransport());
