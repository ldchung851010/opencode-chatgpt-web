import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import type { OpenCodeTurnEnvironment } from "./tool-environment.ts";
import { toolInventoryPage } from "./mcp-contract.ts";
import { callTurnBroker, type BrokerToolResult } from "./turn-broker.ts";

interface ClaimedTurn {
  bindingId: string;
  environment: OpenCodeTurnEnvironment & { expiresAt?: number };
}

const turnTokenSchema = z.string().min(20).max(256);
const toolNameSchema = z.string().min(1).max(512);
const revisionSchema = z.string().min(16).max(256);
const jsonArgumentsSchema = z.record(z.string(), z.unknown()).default({});

function result(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function asMcpResult(value: BrokerToolResult) {
  return {
    content: value.content as never,
    ...(value.structuredContent !== undefined && value.structuredContent !== null && typeof value.structuredContent === "object"
      ? { structuredContent: value.structuredContent as Record<string, unknown> }
      : {}),
    ...(value.isError ? { isError: true } : {}),
    ...(value._meta !== undefined && value._meta !== null && typeof value._meta === "object"
      ? { _meta: value._meta as Record<string, unknown> }
      : {}),
  };
}

function invocationTimeout(environment: OpenCodeTurnEnvironment & { expiresAt?: number }): number | null {
  return environment.expiresAt === undefined ? null : Math.max(1, environment.expiresAt - Date.now());
}

export async function runChatGptMcpServer(options: { brokerSocketPath: string }): Promise<void> {
  const server = new McpServer({ name: "opencode-native", version: "1.0.0" });

  const claimTurn = async (turnToken: string): Promise<ClaimedTurn> => (
    await callTurnBroker<ClaimedTurn>(options.brokerSocketPath, { method: "claim", token: turnToken })
  );

  server.registerTool(
    "opencode_tool_inventory",
    {
      title: "Discover current OpenCode tools",
      description: "Search the exact tool registry advertised by the current OpenCode Responses round. Use the returned revision when calling opencode_tool_call.",
      inputSchema: {
        turn_token: turnTokenSchema,
        query: z.string().max(500).optional(),
        offset: z.number().int().min(0).max(100_000).default(0),
        limit: z.number().int().min(1).max(50).default(20),
        include_schema: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ turn_token, query, offset, limit, include_schema }) => {
      const claimed = await claimTurn(turn_token);
      return result(toolInventoryPage(claimed.environment, {
        ...(query ? { query } : {}),
        offset,
        limit,
        includeSchema: include_schema,
      }) as unknown as Record<string, unknown>);
    },
  );

  server.registerTool(
    "opencode_tool_call",
    {
      title: "Call a native OpenCode tool",
      description: "Invoke one exact tool from the current outer OpenCode tool registry. The bridge only transports the call; OpenCode performs validation, permissions, hooks, and local execution.",
      inputSchema: {
        turn_token: turnTokenSchema,
        name: toolNameSchema,
        revision: revisionSchema,
        arguments: jsonArgumentsSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ turn_token, name, revision, arguments: args }) => {
      const claimed = await claimTurn(turn_token);
      const response = await callTurnBroker<BrokerToolResult>(options.brokerSocketPath, {
        method: "invoke",
        bindingId: claimed.bindingId,
        name,
        revision,
        arguments: args,
      }, invocationTimeout(claimed.environment));
      return asMcpResult(response);
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
