import {
  isOpenCodeChatGptModelId,
  openCodeChatGptModelsList,
  resolveOpenCodeChatGptModelRoute,
  type OpenCodeChatGptCapabilities,
} from "./opencode-models.ts";

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function requestedModelId(rawRequest: unknown): string {
  const body = asObject(rawRequest);
  const model = body?.model;
  if (typeof model !== "string" || model.length === 0) throw new Error("Responses request model is required");
  return model;
}

export function requestedReasoningEffort(rawRequest: unknown): string | undefined {
  const body = asObject(rawRequest);
  const reasoning = asObject(body?.reasoning);
  return typeof reasoning?.effort === "string" ? reasoning.effort : undefined;
}

export function requireLocalChatGptRoute(
  rawRequest: unknown,
  capabilities: OpenCodeChatGptCapabilities,
  localToolsEnabled: boolean,
) {
  const modelId = requestedModelId(rawRequest);
  if (!isOpenCodeChatGptModelId(modelId)) {
    throw new Error(`Unsupported local ChatGPT Web model: ${modelId}`);
  }
  return resolveOpenCodeChatGptModelRoute(
    modelId,
    requestedReasoningEffort(rawRequest),
    capabilities,
    localToolsEnabled,
  );
}

/** Local /v1/models payload. This fork never needs a native Codex catalog request. */
export function localModelsResponseBody(capabilities: OpenCodeChatGptCapabilities): Record<string, unknown> {
  return openCodeChatGptModelsList(capabilities);
}
