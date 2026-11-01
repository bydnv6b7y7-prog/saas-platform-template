import type { InfiniteData } from "@tanstack/react-query";
import { z } from "zod";

import { getApiBaseURL } from "./api-url";

const assistantThreadSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const assistantThreadPageSchema = z.object({
  threads: z.array(assistantThreadSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().nonnegative(),
  perPage: z.number().int().positive(),
  hasMore: z.boolean(),
});

type AssistantThread = z.infer<typeof assistantThreadSchema>;
type AssistantThreadPage = z.infer<typeof assistantThreadPageSchema>;

export function removeAssistantThreadFromCache(
  data: InfiniteData<AssistantThreadPage, unknown> | undefined,
  threadId: string,
): InfiniteData<AssistantThreadPage, unknown> | undefined {
  if (
    !data?.pages.some((page) =>
      page.threads.some((thread) => thread.id === threadId),
    )
  ) {
    return data;
  }
  return {
    ...data,
    pages: data.pages.map((page) => {
      const total = Math.max(0, page.total - 1);
      return {
        ...page,
        threads: page.threads.filter((thread) => thread.id !== threadId),
        total,
        hasMore: (page.page + 1) * page.perPage < total,
      };
    }),
  };
}

export function assistantThreadsQueryKey(userId: string) {
  return ["assistant-threads", userId] as const;
}

function assistantApiUrl(path: string): string {
  return `${getApiBaseURL()}${path}`;
}

async function assistantApiError(
  response: Response,
  fallbackMessage: string,
): Promise<Error> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return new Error(body?.error?.message ?? fallbackMessage);
}

async function parsedResponse<T extends z.ZodType>(
  response: Response,
  schema: T,
  fallbackMessage = "Assistant conversations could not be loaded.",
): Promise<z.infer<T>> {
  if (!response.ok) {
    throw await assistantApiError(response, fallbackMessage);
  }
  return schema.parse(await response.json());
}

export async function listAssistantThreads(
  page: number,
  signal?: AbortSignal,
): Promise<AssistantThreadPage> {
  const response = await fetch(
    assistantApiUrl(`/api/assistant/threads?page=${page}&perPage=20`),
    {
      credentials: "include",
      headers: { accept: "application/json" },
      signal,
    },
  );
  return parsedResponse(response, assistantThreadPageSchema);
}

export async function updateAssistantThreadTitle(
  threadId: string,
  title: string,
): Promise<AssistantThread> {
  const response = await fetch(
    assistantApiUrl(`/api/assistant/threads/${encodeURIComponent(threadId)}`),
    {
      method: "PATCH",
      credentials: "include",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title }),
    },
  );
  return parsedResponse(
    response,
    assistantThreadSchema,
    "Conversation title could not be updated.",
  );
}

export async function deleteAssistantThread(threadId: string): Promise<void> {
  const response = await fetch(
    assistantApiUrl(`/api/assistant/threads/${encodeURIComponent(threadId)}`),
    {
      method: "DELETE",
      credentials: "include",
      headers: { accept: "application/json" },
    },
  );
  if (response.ok) return;
  throw await assistantApiError(response, "Conversation could not be deleted.");
}
