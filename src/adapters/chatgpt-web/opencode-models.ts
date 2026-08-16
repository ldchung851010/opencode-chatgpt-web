export const OPENCODE_CHATGPT_SOL_MODEL = "gpt-5.6-sol";
export const OPENCODE_CHATGPT_LUNA_MODEL = "gpt-5.6-luna";

export type OpenCodeChatGptEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface OpenCodeChatGptCapabilities {
  solAvailable: boolean;
  proAvailable: boolean;
}

export interface OpenCodeChatGptModelRoute {
  requestedModel: string;
  backendModel: typeof OPENCODE_CHATGPT_SOL_MODEL | typeof OPENCODE_CHATGPT_LUNA_MODEL;
  effort: OpenCodeChatGptEffort;
  displayLabel: "Luna" | "Instant" | "Medium" | "High" | "Extra High" | "Pro";
  localTools: boolean;
}

export function isOpenCodeChatGptModelId(modelId: string): boolean {
  return modelId === OPENCODE_CHATGPT_SOL_MODEL || modelId === OPENCODE_CHATGPT_LUNA_MODEL;
}

function effortOf(value: string | undefined): OpenCodeChatGptEffort {
  if (value === undefined || value === "none" || value === "minimal") return "high";
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") return value;
  throw new Error(`ChatGPT Web reasoning effort is not supported: ${value}`);
}

export function resolveOpenCodeChatGptModelRoute(
  modelId: string,
  reasoningEffort: string | undefined,
  capabilities: OpenCodeChatGptCapabilities,
  localToolsEnabled: boolean,
): OpenCodeChatGptModelRoute {
  if (modelId === OPENCODE_CHATGPT_LUNA_MODEL) {
    if (capabilities.solAvailable) {
      throw new Error("gpt-5.6-luna is only available for accounts without the Sol selector");
    }
    const effort = effortOf(reasoningEffort);
    if (reasoningEffort !== undefined && effort !== "low") {
      throw new Error(`gpt-5.6-luna only supports low reasoning effort, not ${reasoningEffort}`);
    }
    return {
      requestedModel: modelId,
      backendModel: OPENCODE_CHATGPT_LUNA_MODEL,
      effort: "low",
      displayLabel: "Luna",
      localTools: localToolsEnabled,
    };
  }

  if (modelId !== OPENCODE_CHATGPT_SOL_MODEL) {
    throw new Error(`ChatGPT Web model is not supported: ${modelId}`);
  }
  if (!capabilities.solAvailable) {
    throw new Error("gpt-5.6-sol is not available for this Luna-only account");
  }

  const effort = effortOf(reasoningEffort);
  if ((effort === "xhigh" || effort === "max") && !capabilities.proAvailable) {
    throw new Error(`gpt-5.6-sol reasoning effort ${effort} is not available for this account`);
  }
  const displayLabel = effort === "low"
    ? "Instant"
    : effort === "medium"
      ? "Medium"
      : effort === "high"
        ? "High"
        : effort === "xhigh"
          ? "Extra High"
          : "Pro";
  return {
    requestedModel: modelId,
    backendModel: OPENCODE_CHATGPT_SOL_MODEL,
    effort,
    displayLabel,
    localTools: localToolsEnabled && effort !== "max",
  };
}

export function openCodeChatGptModelsList(capabilities: OpenCodeChatGptCapabilities): Record<string, unknown> {
  const ids = capabilities.solAvailable ? [OPENCODE_CHATGPT_SOL_MODEL] : [OPENCODE_CHATGPT_LUNA_MODEL];
  return {
    object: "list",
    data: ids.map(id => ({
      id,
      object: "model",
      created: 0,
      owned_by: "chatgpt-web",
    })),
  };
}
