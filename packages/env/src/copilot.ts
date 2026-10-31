export const COPILOT_MODEL_PROVIDERS = [
  "openai-compatible",
  "deepseek",
  "openrouter",
] as const;

export type CopilotModelProvider = (typeof COPILOT_MODEL_PROVIDERS)[number];

export type CopilotModelSettings = {
  provider: CopilotModelProvider;
  model?: string;
  deepseekApiKey?: string;
  openrouterApiKey?: string;
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
};

export type CopilotModelSelection = {
  provider: CopilotModelProvider;
  model: string;
  routerModelId: string | null;
  configured: boolean;
};

const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5-mini";
const DEFAULT_OPENAI_COMPATIBLE_MODEL = "gpt-5-mini";

function nonBlank(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function withoutRouterPrefix(
  value: string,
  provider: "deepseek" | "openrouter",
): string {
  const prefix = `${provider}/`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

export function isCopilotModelProvider(
  value: string,
): value is CopilotModelProvider {
  return COPILOT_MODEL_PROVIDERS.some((provider) => provider === value);
}

export function resolveCopilotModelSelection(
  settings: CopilotModelSettings,
): CopilotModelSelection {
  const configuredModel = nonBlank(settings.model);

  if (settings.provider === "deepseek") {
    const model = withoutRouterPrefix(
      configuredModel ?? DEFAULT_DEEPSEEK_MODEL,
      "deepseek",
    );
    return {
      provider: settings.provider,
      model,
      routerModelId: `deepseek/${model}`,
      configured: Boolean(nonBlank(settings.deepseekApiKey)),
    };
  }

  if (settings.provider === "openrouter") {
    const model = withoutRouterPrefix(
      configuredModel ?? DEFAULT_OPENROUTER_MODEL,
      "openrouter",
    );
    return {
      provider: settings.provider,
      model,
      routerModelId: `openrouter/${model}`,
      configured: Boolean(nonBlank(settings.openrouterApiKey)),
    };
  }

  const explicitModel = configuredModel ?? nonBlank(settings.llmModel);
  return {
    provider: settings.provider,
    model: explicitModel ?? DEFAULT_OPENAI_COMPATIBLE_MODEL,
    routerModelId: null,
    configured: Boolean(
      nonBlank(settings.llmApiKey) &&
        (!nonBlank(settings.llmBaseUrl) || explicitModel),
    ),
  };
}
