import { APPLE_APPLICATION } from "@northwind/env/apple-application";
import { Button } from "@northwind/ui/components/button";
import { Card } from "@northwind/ui/components/card";
import { Skeleton } from "@northwind/ui/components/skeleton";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Image as ImageIcon } from "lucide-react";
import { z } from "zod";

import { AdminNav } from "@/components/admin/admin-nav";
import { formatUtcDateTime } from "@/lib/format";
import { useTRPC } from "@/utils/trpc";

/** Feedback from the iOS app (docs/app-feedback-rating.md); `?id=` is the link in the notification email. */
const searchSchema = z.object({
  id: z.uuid().optional(),
  status: z.enum(["new", "done", "all"]).optional(),
});

export const Route = createFileRoute("/admin/feedback")({
  validateSearch: searchSchema,
  component: AdminFeedbackPage,
});

const CATEGORY_LABELS: Record<string, string> = { bug: "Problem", suggestion: "Suggestion", other: "Other" };
const CONTEXT_LABELS: Record<string, string> = APPLE_APPLICATION.feedbackContexts;
const DIAGNOSTIC_LABELS: Record<string, string> = {
  appVersion: "App version", build: "Build", os: "System", device: "Device", locale: "Language",
  widgetFamilies: "Widgets placed", pro: "Pro", theme: "Colour",
};

function AdminFeedbackPage() {
  const trpc = useTRPC();
  const navigate = useNavigate({ from: Route.fullPath });
  const { id, status = "new" } = Route.useSearch();
  const list = useInfiniteQuery(trpc.appFeedback.list.infiniteQueryOptions(
    { status: status === "all" ? undefined : status, limit: 30 },
    { getNextPageParam: (page) => page.nextCursor ?? undefined },
  ));
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="page-shell max-w-5xl">
      <AdminNav />
      <header className="mb-6">
        <p className="text-sm font-medium text-brand">Administration</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">Feedback</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">From the iOS app. Mark each one done once it is handled.</p>
      </header>

      <div role="group" aria-label="Show" className="mb-4 flex flex-wrap gap-2">
        {(["new", "done", "all"] as const).map((option) => (
          <Button key={option} type="button" variant={status === option ? "default" : "outline"}
            aria-pressed={status === option}
            onClick={() => { void navigate({ search: { status: option } }); }}>
            {option === "new" ? "New" : option === "done" ? "Done" : "All"}
          </Button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card className="gap-0 overflow-hidden py-0">
          {list.isPending ? <Skeleton className="m-4 h-64 rounded-xl" /> : list.isError ? (
            <div className="p-5">
              <p role="alert" className="text-sm text-muted-foreground">Feedback could not be loaded.</p>
              <Button type="button" variant="outline" className="mt-3" onClick={() => { void list.refetch(); }}>Retry</Button>
            </div>
          ) : items.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">Nothing here.</p>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((item) => (
                <li key={item.id}>
                  <button type="button"
                    aria-current={item.id === id ? "true" : undefined}
                    className={`w-full px-5 py-4 text-left transition-colors hover:bg-muted/40 ${item.id === id ? "bg-muted/60" : ""}`}
                    onClick={() => { void navigate({ search: { status, id: item.id } }); }}>
                    <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{CATEGORY_LABELS[item.category] ?? item.category}</span>
                      <span>{formatUtcDateTime(item.createdAt)}</span>
                      {item.appVersion ? <span>v{item.appVersion}</span> : null}
                      {item.hasScreenshot ? <ImageIcon className="size-3.5" role="img" aria-label="Has a screenshot" /> : null}
                      {item.status === "done" ? <span>· Done</span> : null}
                    </p>
                    <p className="mt-1 line-clamp-2 text-sm">{item.message}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {list.hasNextPage ? (
            <div className="border-t border-border p-3">
              <Button type="button" variant="ghost" className="w-full" disabled={list.isFetchingNextPage}
                onClick={() => { void list.fetchNextPage(); }}>
                {list.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </Card>

        {id ? <FeedbackDetail id={id} /> : (
          <Card className="hidden items-center justify-center p-8 text-center text-sm text-muted-foreground lg:flex">Choose a piece of feedback to read it.</Card>
        )}
      </div>
    </div>
  );
}

function FeedbackDetail({ id }: { id: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const detail = useQuery(trpc.appFeedback.detail.queryOptions({ id }));
  const setStatus = useMutation(trpc.appFeedback.setStatus.mutationOptions({
    onSuccess: () => {
      void queryClient.invalidateQueries(trpc.appFeedback.detail.queryFilter({ id }));
      void queryClient.invalidateQueries(trpc.appFeedback.list.pathFilter());
    },
  }));

  if (detail.isPending) return <Skeleton className="h-96 rounded-2xl" />;
  if (detail.isError) return (
    <Card className="p-6">
      <p role="alert" className="text-sm text-muted-foreground">{detail.error.data?.code === "NOT_FOUND" ? "This feedback no longer exists." : "Feedback could not be loaded."}</p>
    </Card>
  );
  const feedback = detail.data;
  // In the order a reader scans them, not the database's key order.
  const order = Object.keys(DIAGNOSTIC_LABELS);
  const diagnostics = Object.entries(feedback.diagnostics ?? {})
    .sort(([a], [b]) => (order.indexOf(a) + 1 || order.length + 1) - (order.indexOf(b) + 1 || order.length + 1));

  return (
    <Card className="gap-5 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{CATEGORY_LABELS[feedback.category] ?? feedback.category}{feedback.context ? ` · ${CONTEXT_LABELS[feedback.context] ?? feedback.context}` : ""}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatUtcDateTime(feedback.createdAt)} · {feedback.signedIn ? "Signed in" : "Not signed in"}
            {feedback.handledAt ? ` · Done ${formatUtcDateTime(feedback.handledAt)}` : ""}
          </p>
        </div>
        <Button type="button" variant={feedback.status === "done" ? "outline" : "default"} disabled={setStatus.isPending}
          onClick={() => setStatus.mutate({ id, status: feedback.status === "done" ? "new" : "done" })}>
          {feedback.status === "done" ? "Mark as new" : "Mark as done"}
        </Button>
      </div>
      {setStatus.isError ? <p role="alert" className="text-sm text-destructive">Could not update. Try again.</p> : null}
      <p className="whitespace-pre-wrap text-sm leading-6">{feedback.message}</p>
      {feedback.contact ? <p className="text-sm"><span className="text-muted-foreground">Contact · </span><span className="break-all">{feedback.contact}</span></p> : null}
      {diagnostics.length ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {diagnostics.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{DIAGNOSTIC_LABELS[key] ?? key}</dt>
              <dd className="break-all">{Array.isArray(value) ? value.join(", ") || "None" : typeof value === "boolean" ? (value ? "Yes" : "No") : String(value)}</dd>
            </div>
          ))}
        </dl>
      ) : <p className="text-sm text-muted-foreground">No diagnostics shared.</p>}
      {feedback.screenshotUrl ? (
        // A 10-minute signed link; reopening the feedback signs a fresh one.
        <img src={feedback.screenshotUrl} alt="Screenshot sent with this feedback" className="max-h-[36rem] w-auto self-start rounded-xl border border-border" />
      ) : feedback.screenshotExpired ? <p className="text-sm text-muted-foreground">The screenshot has passed its retention period.</p>
        : feedback.screenshotStored ? <p className="text-sm text-muted-foreground">A screenshot is stored, but screenshot storage (R2) is not configured on this server.</p> : null}
    </Card>
  );
}
