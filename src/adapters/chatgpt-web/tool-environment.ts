import { createHash } from "node:crypto";

export interface OpenCodeToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  revision: string;
}

export type OpenCodeToolPolicy =
  | { mode: "auto" }
  | { mode: "none" }
  | { mode: "required" }
  | { mode: "specific"; specificName: string };

export interface OpenCodeTurnEnvironment {
  clientSessionId: string;
  parentSessionId?: string;
  tools: OpenCodeToolDefinition[];
  registryRevision: string;
  toolPolicy: OpenCodeToolPolicy;
  parallelToolCalls: boolean;
}

type JsonPrimitive = null | boolean | number | string;
type CanonicalValue = JsonPrimitive | CanonicalValue[] | { [key: string]: CanonicalValue };

function canonicalValue(value: unknown, path = "$", inArray = false): CanonicalValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite number is not valid JSON at ${path}`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (item === undefined) return null;
      return canonicalValue(item, `${path}[${index}]`, true);
    });
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const normalized: { [key: string]: CanonicalValue } = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item === undefined) continue;
      normalized[key] = canonicalValue(item, `${path}.${key}`);
    }
    return normalized;
  }
  if (value === undefined && inArray) return null;
  throw new Error(`value is not JSON-serializable at ${path}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function toolRevision(tool: Pick<OpenCodeToolDefinition, "name" | "description" | "parameters">): string {
  return `tool_${sha256(canonicalJson({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))}`;
}

export function registryRevision(tools: ReadonlyArray<Pick<OpenCodeToolDefinition, "name" | "revision">>): string {
  const entries = [...tools]
    .map(tool => ({ name: tool.name, revision: tool.revision }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return `reg_${sha256(canonicalJson(entries))}`;
}

function objectOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function parseToolPolicy(value: unknown): OpenCodeToolPolicy {
  if (value === undefined || value === "auto") return { mode: "auto" };
  if (value === "none") return { mode: "none" };
  if (value === "required") return { mode: "required" };
  const choice = objectOf(value, "tool_choice");
  if (choice.type !== "function" || typeof choice.name !== "string" || choice.name.length === 0) {
    throw new Error("tool_choice must be auto, none, required, or an exact function choice");
  }
  return { mode: "specific", specificName: choice.name };
}

function parseTools(value: unknown): OpenCodeToolDefinition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("tools must be an array");
  const seen = new Set<string>();
  const tools = value.map((raw, index) => {
    const tool = objectOf(raw, `tools[${index}]`);
    if (tool.type !== "function") throw new Error(`tools[${index}] must be a function tool`);
    if (typeof tool.name !== "string" || tool.name.length === 0) throw new Error(`tools[${index}].name is required`);
    if (seen.has(tool.name)) throw new Error(`duplicate tool name in active OpenCode round: ${tool.name}`);
    seen.add(tool.name);
    const description = typeof tool.description === "string" ? tool.description : "";
    const parameters = objectOf(tool.parameters ?? {}, `tools[${index}].parameters`);
    const base = { name: tool.name, description, parameters };
    return { ...base, revision: toolRevision(base) };
  });
  return tools.sort((left, right) => left.name.localeCompare(right.name));
}

export function environmentFromResponsesRequest(
  rawRequest: unknown,
  clientSessionId: string,
  parentSessionId?: string,
): OpenCodeTurnEnvironment {
  if (!clientSessionId.trim()) throw new Error("OpenCode X-Session-Id is required");
  const body = objectOf(rawRequest, "Responses request");
  const tools = parseTools(body.tools);
  return {
    clientSessionId,
    ...(parentSessionId ? { parentSessionId } : {}),
    tools,
    registryRevision: registryRevision(tools),
    toolPolicy: parseToolPolicy(body.tool_choice),
    // OpenAI Responses defaults to allowing parallel tool calls unless explicitly disabled.
    parallelToolCalls: body.parallel_tool_calls !== false,
  };
}

export class ToolUnavailableError extends Error {
  readonly code = "ToolUnavailable";
}

export class ToolSchemaChangedError extends Error {
  readonly code = "ToolSchemaChanged";
}

export class ToolPolicyError extends Error {
  readonly code = "ToolPolicyViolation";
}

export class ParallelToolCallError extends Error {
  readonly code = "ParallelToolCallsDisabled";
}

export function validateToolInvocation(
  environment: OpenCodeTurnEnvironment,
  request: { name: string; revision: string },
  pendingInvocationCount = 0,
): OpenCodeToolDefinition {
  const tool = environment.tools.find(candidate => candidate.name === request.name);
  if (!tool) throw new ToolUnavailableError(`OpenCode tool is not available in the current round: ${request.name}`);
  if (tool.revision !== request.revision) {
    throw new ToolSchemaChangedError(
      `OpenCode tool schema changed for ${request.name}; refresh opencode_tool_inventory before retrying`,
    );
  }
  if (environment.toolPolicy.mode === "none") {
    throw new ToolPolicyError(`tool_choice=none forbids OpenCode tool calls (${request.name})`);
  }
  if (environment.toolPolicy.mode === "specific" && environment.toolPolicy.specificName !== request.name) {
    throw new ToolPolicyError(
      `tool_choice requires ${environment.toolPolicy.specificName}, not ${request.name}`,
    );
  }
  if (!environment.parallelToolCalls && pendingInvocationCount > 0) {
    throw new ParallelToolCallError("parallel_tool_calls=false permits only one unresolved OpenCode tool call");
  }
  return tool;
}
