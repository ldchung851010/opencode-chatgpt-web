import { createHash } from "node:crypto";
import { canonicalJson } from "./tool-environment.ts";

export type HeaderBag = Headers | Record<string, string | string[] | undefined>;

function headerValue(headers: HeaderBag, name: string): string | undefined {
  if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(name) ?? undefined;
  const needle = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== needle) continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
}

export function requireOpenCodeSession(headers: HeaderBag): string {
  const sessionId = headerValue(headers, "x-session-id")?.trim();
  if (!sessionId) throw new Error("OpenCode requests must include X-Session-Id");
  return sessionId;
}

export function openCodeParentSession(headers: HeaderBag): string | undefined {
  const value = headerValue(headers, "x-parent-session-id")?.trim();
  return value || undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isHumanUserItem(value: unknown): boolean {
  return asObject(value)?.role === "user";
}

export function currentProviderRoundItems(rawRequest: unknown): unknown[] {
  const body = asObject(rawRequest);
  if (!body || !Array.isArray(body.input)) throw new Error("Responses request input must be an array");
  let latestUser = -1;
  for (let index = body.input.length - 1; index >= 0; index -= 1) {
    if (!isHumanUserItem(body.input[index])) continue;
    latestUser = index;
    break;
  }
  if (latestUser < 0) return [...body.input];
  return body.input.slice(latestUser + 1);
}

export interface CurrentToolResult {
  callId: string;
  output: unknown;
}

export function currentToolResults(rawRequest: unknown): CurrentToolResult[] {
  const results = new Map<string, CurrentToolResult>();
  for (const item of currentProviderRoundItems(rawRequest)) {
    const value = asObject(item);
    if (!value || value.type !== "function_call_output") continue;
    if (typeof value.call_id !== "string" || value.call_id.length === 0) {
      throw new Error("function_call_output.call_id is required");
    }
    if (results.has(value.call_id)) throw new Error(`duplicate function_call_output for ${value.call_id}`);
    results.set(value.call_id, { callId: value.call_id, output: value.output });
  }
  return [...results.values()];
}

export function requestFingerprint(clientSessionId: string, rawRequest: unknown): string {
  if (!clientSessionId) throw new Error("clientSessionId is required for request fingerprinting");
  return createHash("sha256")
    .update(clientSessionId)
    .update("\0")
    .update(canonicalJson(rawRequest))
    .digest("hex");
}


function dataUrl(value: string): { mimeType: string; base64: string } | undefined {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value);
  if (!match) return undefined;
  return { mimeType: match[1]!, base64: match[2]!.replace(/\s+/g, "") };
}

export function brokerResultFromFunctionCallOutput(output: unknown): {
  content: unknown[];
  structuredContent?: unknown;
} {
  if (typeof output === "string") {
    let structuredContent: unknown;
    try {
      const parsed = JSON.parse(output);
      if (parsed !== null && typeof parsed === "object") structuredContent = parsed;
    } catch {}
    return {
      content: [{ type: "text", text: output }],
      ...(structuredContent !== undefined ? { structuredContent } : {}),
    };
  }
  if (Array.isArray(output)) {
    const content = output.map((raw, index) => {
      const item = asObject(raw);
      if (!item) throw new Error(`function_call_output.output[${index}] must be an object`);
      if (item.type === "input_text" && typeof item.text === "string") {
        return { type: "text", text: item.text };
      }
      if (item.type === "input_image" && typeof item.image_url === "string") {
        const parsed = dataUrl(item.image_url);
        if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mimeType };
        return { type: "resource_link", uri: item.image_url, name: "OpenCode tool image", mimeType: "image/*" };
      }
      throw new Error(`unsupported function_call_output content item at index ${index}`);
    });
    return { content };
  }
  if (output !== null && typeof output === "object") {
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    };
  }
  return { content: [{ type: "text", text: String(output ?? "") }] };
}
