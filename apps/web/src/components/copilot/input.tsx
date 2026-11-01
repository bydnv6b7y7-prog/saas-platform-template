import {
  CopilotChatInput,
  type CopilotChatInputProps,
} from "@copilotkit/react-core/v2";

import { useAssistantControl } from "./context";

export const AssistantInput = Object.assign(
  function AssistantInput(props: CopilotChatInputProps) {
    const { usage } = useAssistantControl();
    const exhausted = usage?.daily.remaining === 0;
    const blocked = exhausted && !props.isRunning;

    return (
      <CopilotChatInput
        {...props}
        onSubmitMessage={blocked ? undefined : props.onSubmitMessage}
        sendButton={blocked ? { disabled: true } : props.sendButton}
        textArea={
          exhausted
            ? {
                disabled: true,
                placeholder: "Daily limit reached",
              }
            : props.textArea
        }
      />
    );
  },
  {
    SendButton: CopilotChatInput.SendButton,
    ToolbarButton: CopilotChatInput.ToolbarButton,
    StartTranscribeButton: CopilotChatInput.StartTranscribeButton,
    CancelTranscribeButton: CopilotChatInput.CancelTranscribeButton,
    FinishTranscribeButton: CopilotChatInput.FinishTranscribeButton,
    AddMenuButton: CopilotChatInput.AddMenuButton,
    TextArea: CopilotChatInput.TextArea,
    AudioRecorder: CopilotChatInput.AudioRecorder,
    Disclaimer: CopilotChatInput.Disclaimer,
  },
);
