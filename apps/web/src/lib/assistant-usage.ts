import {
  assistantUsageStatusSchema,
  type AssistantUsageStatus,
} from "@northwind/billing";
import { queryOptions } from "@tanstack/react-query";

import { getApiBaseURL } from "./api-url";

export function assistantUsageQueryKey(userId: string) {
  return ["assistant-usage", userId] as const;
}

export function assistantUsageQueryOptions(userId: string) {
  return queryOptions({
    queryKey: assistantUsageQueryKey(userId),
    queryFn: async (): Promise<AssistantUsageStatus> => {
      const response = await fetch(`${getApiBaseURL()}/api/assistant/usage`, {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error("Assistant usage could not be loaded");
      return assistantUsageStatusSchema.parse(await response.json());
    },
    staleTime: 30_000,
  });
}

export function assistantQuotaMessage(usage: AssistantUsageStatus): string {
  const label =
    usage.accessSource === "admin"
      ? "Admin"
      : usage.plan === "free"
        ? "Free"
        : "Pro";
  return `${label} · ${usage.daily.remaining} of ${usage.limits.perDay} requests left today`;
}
