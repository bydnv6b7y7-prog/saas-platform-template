import { describe, expect, it } from "bun:test";
import { resolveCopilotModelSelection } from "@northwind/env/copilot";
import { copilotProviderOptions } from "./model";

describe("Copilot model selection", () => {
  it("keeps the existing OpenAI-compatible path as the default", () => {
    expect(
      resolveCopilotModelSelection({
        provider: "openai-compatible",
        llmApiKey: "legacy-key",
      }),
    ).toEqual({
      provider: "openai-compatible",
      model: "gpt-5-mini",
      routerModelId: null,
      configured: true,
    });
  });

  it("requires an explicit model for a custom OpenAI-compatible base URL", () => {
    expect(
      resolveCopilotModelSelection({
        provider: "openai-compatible",
        llmApiKey: "legacy-key",
        llmBaseUrl: "https://example.com/v1",
      }).configured,
    ).toBe(false);
    expect(
      resolveCopilotModelSelection({
        provider: "openai-compatible",
        model: "custom-chat",
        llmApiKey: "legacy-key",
        llmBaseUrl: "https://example.com/v1",
      }).configured,
    ).toBe(true);
  });

  it("selects the native DeepSeek router and accepts its full model id", () => {
    expect(
      resolveCopilotModelSelection({
        provider: "deepseek",
        model: "deepseek/deepseek-v4-pro",
        deepseekApiKey: "deepseek-key",
      }),
    ).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      routerModelId: "deepseek/deepseek-v4-pro",
      configured: true,
    });
  });

  it("uses the documented DeepSeek default when no model is specified", () => {
    expect(
      resolveCopilotModelSelection({
        provider: "deepseek",
        deepseekApiKey: "deepseek-key",
      }),
    ).toMatchObject({
      model: "deepseek-v4-flash",
      routerModelId: "deepseek/deepseek-v4-flash",
      configured: true,
    });
  });

  it("selects OpenRouter without confusing its upstream provider prefix", () => {
    expect(
      resolveCopilotModelSelection({
        provider: "openrouter",
        model: "openrouter/deepseek/deepseek-v4-flash",
        openrouterApiKey: "openrouter-key",
      }),
    ).toEqual({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      routerModelId: "openrouter/deepseek/deepseek-v4-flash",
      configured: true,
    });
  });

  it("uses a tool-capable OpenRouter default when no model is specified", () => {
    expect(
      resolveCopilotModelSelection({
        provider: "openrouter",
        openrouterApiKey: "openrouter-key",
      }),
    ).toMatchObject({
      model: "openai/gpt-5-mini",
      routerModelId: "openrouter/openai/gpt-5-mini",
      configured: true,
    });
  });

  it("does not use another provider's credential", () => {
    expect(
      resolveCopilotModelSelection({
        provider: "deepseek",
        openrouterApiKey: "wrong-provider-key",
      }).configured,
    ).toBe(false);
  });

  it("disables DeepSeek chain-of-thought while leaving other providers untouched", () => {
    expect(copilotProviderOptions("deepseek")).toEqual({
      deepseek: { thinking: { type: "disabled" } },
    });
    expect(copilotProviderOptions("openrouter")).toBeUndefined();
    expect(copilotProviderOptions("openai-compatible")).toBeUndefined();
  });
});
