import type { AssistantPageContext } from "@northwind/product/assistant-contracts";
import {
  useAgentContext,
  useConfigureSuggestions,
} from "@copilotkit/react-core/v2";
import { useMemo } from "react";

import { assistantSuggestions } from "@/product";
import { assistantPageContextDescription } from "@/product/assistant";

import { AGENT_ID, useAssistantControl } from "./context";

export function AssistantBehavior({
  pageContext,
}: {
  pageContext: AssistantPageContext;
}) {
  const { usage } = useAssistantControl();
  const exhausted = usage.daily.remaining === 0;
  const suggestions = useMemo(
    () => (exhausted ? [] : assistantSuggestions(pageContext)),
    [exhausted, pageContext],
  );

  useAgentContext({
    description: assistantPageContextDescription,
    value: pageContext,
  });
  useConfigureSuggestions(
    {
      consumerAgentId: AGENT_ID,
      available: "before-first-message",
      suggestions,
    },
    [exhausted, pageContext],
  );

  return null;
}
