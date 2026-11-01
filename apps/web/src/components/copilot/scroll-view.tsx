import { CopilotChatView } from "@copilotkit/react-core/v2";
import type { ComponentProps, ComponentType } from "react";

type ScrollViewProps = ComponentProps<typeof CopilotChatView.ScrollView>;

// CopilotKit forwards these options to use-stick-to-bottom but does not expose
// them in the v2 ScrollView type yet.
const InstantScrollView = CopilotChatView.ScrollView as ComponentType<
  ScrollViewProps & {
    initial?: ScrollBehavior;
    resize?: ScrollBehavior;
  }
>;

export function AssistantScrollView(props: ScrollViewProps) {
  return (
    <InstantScrollView
      {...props}
      initial="instant"
      resize="instant"
    />
  );
}
