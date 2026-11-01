/** Assistant pieces of the web product seam; loaded with the lazily imported copilot sidecar. */
import type { AssistantPageContext } from "@northwind/product/assistant-contracts";
import { useLocation } from "@tanstack/react-router";
import { useMemo } from "react";

import { buildAssistantPageContext } from "@/product";
import { NotesPageTools, NotesToolRenderers } from "@/product/notes/assistant";

export function useAssistantPageContext(): AssistantPageContext {
  const pathname = useLocation({ select: (location) => location.pathname });
  return useMemo(() => buildAssistantPageContext(pathname, {}), [pathname]);
}

/** Frontend tools (useFrontendTool / useHumanInTheLoop) that let the assistant act on the page. */
export function AssistantPageTools() {
  return <NotesPageTools />;
}

/** Custom renderers for backend tool results (useRenderTool). */
export function AssistantToolRenderers() {
  return <NotesToolRenderers />;
}

/** Optional card above the welcome suggestions. */
export function AssistantWelcomeContext() {
  return null;
}

export const assistantInputPlaceholder = "Ask anything…";
export const assistantVerifyHint = "Verify important answers.";

/** Tells the model what the shared page context is. */
export const assistantPageContextDescription = "The page the user is currently viewing.";

export function assistantWelcomeHeading(_pageContext: AssistantPageContext): string {
  return "How can I help?";
}
