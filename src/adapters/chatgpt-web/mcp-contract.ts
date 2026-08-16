import type { OpenCodeToolDefinition, OpenCodeTurnEnvironment } from "./tool-environment.ts";

export interface OpenCodeToolInventoryItem {
  name: string;
  description: string;
  revision: string;
  parameters?: Record<string, unknown>;
}

export interface OpenCodeToolInventoryPage {
  registry_revision: string;
  offset: number;
  limit: number;
  total: number;
  has_more: boolean;
  tools: OpenCodeToolInventoryItem[];
}

function normalizedQuery(query?: string): string | undefined {
  const value = query?.trim().toLowerCase();
  return value || undefined;
}

function matches(tool: OpenCodeToolDefinition, query?: string): boolean {
  const needle = normalizedQuery(query);
  if (!needle) return true;
  return `${tool.name}\n${tool.description}`.toLowerCase().includes(needle);
}

export function toolInventoryPage(
  environment: OpenCodeTurnEnvironment,
  options: { query?: string; offset?: number; limit?: number; includeSchema?: boolean } = {},
): OpenCodeToolInventoryPage {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  const includeSchema = options.includeSchema ?? true;
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) throw new Error("inventory offset is invalid");
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("inventory limit is invalid");

  const matchesList = environment.tools.filter(tool => matches(tool, options.query));
  const selected = matchesList.slice(offset, offset + limit).map(tool => ({
    name: tool.name,
    description: tool.description,
    revision: tool.revision,
    ...(includeSchema ? { parameters: tool.parameters } : {}),
  }));

  return {
    registry_revision: environment.registryRevision,
    offset,
    limit,
    total: matchesList.length,
    has_more: offset + selected.length < matchesList.length,
    tools: selected,
  };
}

export function requireInventoryTool(
  environment: OpenCodeTurnEnvironment,
  name: string,
  revision: string,
): OpenCodeToolDefinition {
  const tool = environment.tools.find(candidate => candidate.name === name);
  if (!tool) throw new Error(`OpenCode tool is not available in the current round: ${name}`);
  if (tool.revision !== revision) {
    const error = new Error(`OpenCode tool schema changed for ${name}; refresh opencode_tool_inventory before retrying`) as Error & { code?: string };
    error.code = "ToolSchemaChanged";
    throw error;
  }
  return tool;
}
