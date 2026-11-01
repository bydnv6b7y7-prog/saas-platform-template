import type { AssistantUsageStatus } from "@northwind/billing";
import { CopilotKit } from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useState,
} from "react";

import {
  COPILOT_RUNTIME_URL,
  type CopilotErrorEvent,
} from "./context";
import { AppStoreCopilotRuntime } from "./runtime";
import { assistantUsageQueryKey } from "@/lib/assistant-usage";
import { assistantFailureReassurance } from "@/product";

export function AppStoreCopilot({
  open,
  onOpenChange,
  usage,
  userId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  usage: AssistantUsageStatus;
  userId: string;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const handleError = useCallback((event: CopilotErrorEvent) => {
    console.error("[Northwind AI] CopilotKit error", event.type);
    void queryClient.invalidateQueries({
      queryKey: assistantUsageQueryKey(userId),
    });
    setError(
      `Northwind AI could not complete this request. ${assistantFailureReassurance}`,
    );
  }, [queryClient, userId]);
  const clearError = useCallback(() => setError(null), []);

  return (
    <CopilotKit
      runtimeUrl={COPILOT_RUNTIME_URL}
      credentials="include"
      useSingleEndpoint={false}
      enableInspector={false}
      showDevConsole={false}
      onError={handleError}
    >
      <AppStoreCopilotRuntime
        clearError={clearError}
        open={open}
        error={error}
        onOpenChange={onOpenChange}
        usage={usage}
        userId={userId}
      />
    </CopilotKit>
  );
}
