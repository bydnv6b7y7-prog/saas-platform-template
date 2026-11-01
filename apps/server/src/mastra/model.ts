import { env } from "@northwind/env/server";
import {
  resolveCopilotModelSelection,
  type CopilotModelSelection,
} from "@northwind/env/copilot";
import { createOpenAI } from "@ai-sdk/openai";
import type { MastraModelConfig } from "@mastra/core/llm";

const environmentCopilotModelSelection = resolveCopilotModelSelection({
  provider: env.COPILOT_MODEL_PROVIDER,
  model: env.COPILOT_MODEL,
  deepseekApiKey: env.DEEPSEEK_API_KEY,
  openrouterApiKey: env.OPENROUTER_API_KEY,
  llmApiKey: env.LLM_API_KEY,
  llmBaseUrl: env.LLM_BASE_URL,
  llmModel: env.LLM_MODEL,
});

function environmentApiKey(): string | undefined {
  if (environmentCopilotModelSelection.provider === "deepseek") {
    return env.DEEPSEEK_API_KEY;
  }
  if (environmentCopilotModelSelection.provider === "openrouter") {
    return env.OPENROUTER_API_KEY;
  }
  return env.LLM_API_KEY;
}

export function getCopilotModelStatus(): CopilotModelSelection {
  return { ...environmentCopilotModelSelection };
}

/** Keep private chain-of-thought out of DeepSeek runs; users see verified run stages instead. */
export function copilotProviderOptions(
  provider: CopilotModelSelection["provider"],
) {
  return provider === "deepseek"
    ? { deepseek: { thinking: { type: "disabled" as const } } }
    : undefined;
}

/** Mastra resolves this DynamicArgument for every agent run. */
export function assistantModel(): MastraModelConfig {
  const runtime = getCopilotModelStatus();
  const apiKey = environmentApiKey();
  if (!runtime.configured || !apiKey) {
    throw new Error("Copilot model is not configured.");
  }
  if (runtime.routerModelId) {
    return {
      id: runtime.routerModelId as `${string}/${string}`,
      apiKey,
    };
  }

  const provider = createOpenAI({
    apiKey,
    ...(env.LLM_BASE_URL ? { baseURL: env.LLM_BASE_URL } : {}),
    name: "northwind-llm",
  });
  return provider.chat(runtime.model);
}
