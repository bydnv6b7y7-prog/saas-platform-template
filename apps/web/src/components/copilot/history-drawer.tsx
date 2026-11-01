import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ChevronRight,
  History,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";

import {
  assistantThreadsQueryKey,
  deleteAssistantThread,
  listAssistantThreads,
  removeAssistantThreadFromCache,
} from "@/lib/assistant-threads";
import { formatUtcDateTime } from "@/lib/format";

import {
  focusChatInput,
  focusHistoryTrigger,
  useAssistantControl,
} from "./context";
import { assistantName } from "@/lib/brand";

export function AssistantHistoryDrawer() {
  const {
    activeThreadId,
    isRunning,
    selectThread,
    setHistoryOpen,
    startNewThread,
    userId,
  } = useAssistantControl();
  const queryClient = useQueryClient();
  const [deleteCandidate, setDeleteCandidate] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const queryKey = assistantThreadsQueryKey(userId);
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => listAssistantThreads(pageParam, signal),
    getNextPageParam: (page) => (page.hasMore ? page.page + 1 : undefined),
  });
  const deletion = useMutation({
    mutationFn: deleteAssistantThread,
    onSuccess: (_result, threadId) => {
      if (threadId === activeThreadId) startNewThread();
      queryClient.setQueryData(queryKey, (data: typeof query.data) =>
        removeAssistantThreadFromCache(data, threadId),
      );
      setDeleteCandidate(null);
      setDeleteError(null);
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => {
      setDeleteError(
        error instanceof Error
          ? error.message
          : "Conversation could not be deleted.",
      );
    },
  });
  const threads = query.data?.pages.flatMap((page) => page.threads) ?? [];
  const interactionLocked = isRunning || deletion.isPending;

  const close = () => {
    setHistoryOpen(false);
    focusHistoryTrigger();
  };
  const startNew = () => {
    if (interactionLocked) return;
    startNewThread();
    setHistoryOpen(false);
    focusChatInput();
  };
  const openThread = (threadId: string) => {
    if (interactionLocked) return;
    if (threadId !== activeThreadId) selectThread(threadId);
    setHistoryOpen(false);
    focusChatInput();
  };

  return (
    <section
      data-assistant-history
      role="dialog"
      aria-labelledby="assistant-history-title"
      className="assistant-history-drawer"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !deleteCandidate) return;
        event.preventDefault();
        event.stopPropagation();
        setDeleteCandidate(null);
        setDeleteError(null);
      }}
    >
      <header className="flex min-h-16 items-center gap-3 border-b border-border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 id="assistant-history-title" className="text-sm font-semibold">
            Conversations
          </h2>
          <p className="text-xs text-muted-foreground">
            Saved privately to your account
          </p>
        </div>
        <button
          type="button"
          data-assistant-history-close
          aria-label="Close conversation history"
          onClick={close}
          className="assistant-icon-button"
        >
          <X className="size-5" aria-hidden="true" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
        <button
          type="button"
          onClick={startNew}
          disabled={interactionLocked}
          className="mb-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-foreground px-3 text-sm font-medium text-background outline-none transition-colors hover:bg-foreground/90 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Plus className="size-4" aria-hidden="true" />
          New conversation
        </button>
        {isRunning ? (
          <p className="mb-3 rounded-xl bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">
            You can review history while {assistantName} is working. Switching and
            starting a conversation are available when this answer finishes.
          </p>
        ) : null}

        {query.isPending ? (
          <div className="grid flex-1 place-items-center py-10 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <LoaderCircle className="assistant-spinner size-4" aria-hidden="true" />
              Loading conversations
            </span>
          </div>
        ) : query.isError ? (
          <div className="grid flex-1 place-items-center px-5 py-10 text-center">
            <div>
              <p className="text-sm font-medium">History could not be loaded.</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Your saved conversations are unchanged.
              </p>
              <button
                type="button"
                onClick={() => void query.refetch()}
                className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-xl border border-border px-3 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <RefreshCw className="size-4" aria-hidden="true" />
                Retry
              </button>
            </div>
          </div>
        ) : threads.length === 0 ? (
          <div className="grid flex-1 place-items-center px-5 py-10 text-center">
            <div>
              <History className="mx-auto size-5 text-muted-foreground" aria-hidden="true" />
              <p className="mt-3 text-sm font-medium">No conversations yet</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                A conversation appears here after you send its first message.
              </p>
            </div>
          </div>
        ) : (
          <ul className="space-y-1" aria-label="Saved conversations">
            {threads.map((thread) => {
              const current = activeThreadId === thread.id;
              const confirmingDelete = deleteCandidate === thread.id;
              return (
                <li key={thread.id}>
                  {confirmingDelete ? (
                    <div
                      role="group"
                      aria-label="Confirm conversation deletion"
                      className="rounded-xl border border-destructive/25 bg-destructive/5 p-3"
                    >
                      <p className="text-sm font-medium text-foreground">
                        Delete this conversation?
                      </p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        Its messages and saved context will be permanently
                        removed.
                      </p>
                      {deleteError ? (
                        <p role="alert" className="mt-2 text-xs text-destructive">
                          {deleteError}
                        </p>
                      ) : null}
                      <div className="mt-3 flex justify-end gap-2">
                        <button
                          type="button"
                          autoFocus
                          disabled={deletion.isPending}
                          onClick={() => {
                            setDeleteCandidate(null);
                            setDeleteError(null);
                          }}
                          className="min-h-9 rounded-lg px-3 text-xs font-medium text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={deletion.isPending}
                          onClick={() => deletion.mutate(thread.id)}
                          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-destructive/10 px-3 text-xs font-medium text-destructive outline-none hover:bg-destructive/20 focus-visible:ring-2 focus-visible:ring-destructive/40 disabled:opacity-50"
                        >
                          {deletion.isPending ? (
                            <LoaderCircle
                              className="assistant-spinner size-3.5"
                              aria-hidden="true"
                            />
                          ) : null}
                          Delete
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div
                      data-current={current ? "true" : "false"}
                      className="group flex min-h-15 items-center rounded-xl transition-colors hover:bg-muted focus-within:bg-muted data-[current=true]:bg-muted"
                    >
                      <button
                        type="button"
                        onClick={() => openThread(thread.id)}
                        disabled={interactionLocked}
                        aria-current={current ? "page" : undefined}
                        className="flex min-w-0 flex-1 items-center gap-3 self-stretch rounded-l-xl px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">
                            {thread.title ?? "Untitled conversation"}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {formatUtcDateTime(thread.updatedAt)}
                          </span>
                        </span>
                        {current ? (
                          <span className="rounded-full bg-brand/10 px-2 py-1 text-[11px] font-medium text-brand">
                            Current
                          </span>
                        ) : (
                          <ChevronRight
                            className="size-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                        )}
                      </button>
                      <button
                        type="button"
                        disabled={interactionLocked}
                        aria-label={`Delete ${thread.title ?? "untitled conversation"}`}
                        onClick={() => {
                          setDeleteCandidate(thread.id);
                          setDeleteError(null);
                        }}
                        className="mr-1 grid size-10 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {query.hasNextPage ? (
          <button
            type="button"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
            className="mt-3 min-h-11 rounded-xl border border-border px-3 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </div>
    </section>
  );
}
