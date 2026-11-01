import {
  CopilotChatInput,
  CopilotChatMessageView,
  CopilotChatView,
  CopilotSidebarView,
  type CopilotChatInputProps,
  type CopilotChatViewProps,
} from "@copilotkit/react-core/v2";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps } from "react";

import { focusChatInput, useAssistantControl } from "./context";
import { AppStoreCopilotHeader } from "./header";
import { CopilotSurfaceBridge } from "./surface-bridge";

const THREAD_LOADING_DELAY_MS = 180;

const ThreadLoadingMessageView = Object.assign(
  function ThreadLoadingMessageView(
    _props: ComponentProps<typeof CopilotChatMessageView>,
  ) {
    const [visible, setVisible] = useState(false);

    useEffect(() => {
      const timer = window.setTimeout(
        () => setVisible(true),
        THREAD_LOADING_DELAY_MS,
      );
      return () => window.clearTimeout(timer);
    }, []);

    return (
      <div
        role={visible ? "status" : undefined}
        aria-live={visible ? "polite" : undefined}
        className="pointer-events-none absolute inset-x-0 top-1/2 z-10 flex -translate-y-1/2 justify-center px-6"
      >
        {visible ? (
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle
              className="assistant-spinner size-4 shrink-0"
              aria-hidden="true"
            />
            Loading conversation…
          </span>
        ) : null}
      </div>
    );
  },
  { Cursor: CopilotChatMessageView.Cursor },
);

const ThreadLoadingInput = Object.assign(
  function ThreadLoadingInput(props: CopilotChatInputProps) {
    return (
      <CopilotChatInput
        {...props}
        onSubmitMessage={undefined}
        sendButton={{ disabled: true }}
        textArea={{
          disabled: true,
          placeholder: "Loading conversation…",
        }}
      />
    );
  },
  CopilotChatInput,
);

export const AppStoreCopilotSidebarView = Object.assign(
  function AppStoreCopilotSidebarView({
    input,
    isConnecting = false,
    messageView,
    ...props
  }: CopilotChatViewProps) {
    const { historyOpen, open } = useAssistantControl();
    const wasConnecting = useRef(isConnecting);

    useEffect(() => {
      const finishedConnecting = wasConnecting.current && !isConnecting;
      wasConnecting.current = isConnecting;
      if (finishedConnecting && open && !historyOpen) focusChatInput();
    }, [historyOpen, isConnecting, open]);

    return (
      <CopilotSidebarView
        {...props}
        aria-busy={isConnecting}
        defaultOpen={false}
        header={AppStoreCopilotHeader}
        input={isConnecting ? ThreadLoadingInput : input}
        isConnecting={isConnecting}
        messageView={isConnecting ? ThreadLoadingMessageView : messageView}
        position="right"
        toggleButton={CopilotSurfaceBridge}
        width="var(--northwind-copilot-sidebar-width, 420px)"
      />
    );
  },
  CopilotChatView,
);
