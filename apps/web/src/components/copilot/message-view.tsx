import { CopilotChatMessageView } from "@copilotkit/react-core/v2";
import { LoaderCircle } from "lucide-react";
import type { ComponentProps } from "react";

import { ASSISTANT_RUN_PHASE_LABELS } from "@/lib/assistant-run-state";

import { useAssistantControl } from "./context";

export const AppStoreMessageView = Object.assign(
  function AppStoreMessageView({
    children: _children,
    ...props
  }: ComponentProps<typeof CopilotChatMessageView>) {
    const { phase } = useAssistantControl();
    return (
      <CopilotChatMessageView {...props}>
        {({ messageElements, interruptElement }) => (
          <>
            {messageElements}
            {interruptElement}
            {phase ? (
              <div role="status" aria-live="polite" className="assistant-run-status">
                <LoaderCircle
                  className="assistant-spinner size-4 shrink-0"
                  aria-hidden="true"
                />
                <span>{ASSISTANT_RUN_PHASE_LABELS[phase]}</span>
              </div>
            ) : null}
          </>
        )}
      </CopilotChatMessageView>
    );
  },
  { Cursor: CopilotChatMessageView.Cursor },
);
