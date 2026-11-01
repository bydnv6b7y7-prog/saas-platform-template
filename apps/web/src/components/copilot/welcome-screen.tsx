import { CopilotSidebarView } from "@copilotkit/react-core/v2";
import type { ComponentProps } from "react";

import { useAssistantControl } from "./context";
import { AssistantWelcomeContext, assistantWelcomeHeading } from "@/product/assistant";

type WelcomeScreenProps = ComponentProps<typeof CopilotSidebarView.WelcomeScreen>;

export function AppStoreWelcomeScreen({
  input,
  suggestionView,
  className,
  welcomeMessage: _welcomeMessage,
  children: _children,
  ...props
}: WelcomeScreenProps) {
  const { pageContext } = useAssistantControl();
  const heading = assistantWelcomeHeading(pageContext);

  return (
    <div className={`assistant-welcome ${className ?? ""}`} {...props}>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-xl">
          <div className="mb-3">
            <h2 className="text-lg font-semibold tracking-[-0.025em] text-foreground">
              {heading}
            </h2>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              Ask a question or start with a grounded analysis below.
            </p>
          </div>
          <AssistantWelcomeContext />
          <div className="mt-3">{suggestionView}</div>
        </div>
      </div>
      <div className="border-t border-border/70 px-4 pb-4 pt-3">{input}</div>
    </div>
  );
}
