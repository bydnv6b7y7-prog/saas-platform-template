import { APPLE_APPLICATION } from "@northwind/env/apple-application";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_CONTEXTS,
  REVIEW_TRIGGERS,
  appClientConfigSchema,
  type AppClientConfig,
} from "@northwind/env/app-client-config";
import { Button } from "@northwind/ui/components/button";
import { Input } from "@northwind/ui/components/input";
import { Skeleton } from "@northwind/ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Save } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { formatUtcDateTime } from "@/lib/format";
import { useTRPC } from "@/utils/trpc";

/**
 * The iOS app's remote settings (docs/app-feedback-rating.md): when it asks for
 * an App Store review, and how its feedback form behaves. The app keeps its
 * built-in defaults whenever these cannot be read.
 */
const TRIGGER_LABELS: Record<(typeof REVIEW_TRIGGERS)[number], string> = APPLE_APPLICATION.reviewTriggers;
const CATEGORY_LABELS: Record<(typeof FEEDBACK_CATEGORIES)[number], string> = {
  bug: "Problem",
  suggestion: "Suggestion",
  other: "Other",
};
const CONTEXT_LABELS: Record<(typeof FEEDBACK_CONTEXTS)[number], string> = APPLE_APPLICATION.feedbackContexts;

type NumberKey<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];

export function AppClientSettings() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const overview = useQuery(trpc.config.appClient.overview.queryOptions());
  const history = useQuery(trpc.config.appClient.history.queryOptions());
  const [draft, setDraft] = useState<AppClientConfig | null>(null);
  const [baseRevision, setBaseRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (overview.data && !draft) {
      setDraft(overview.data.values);
      setBaseRevision(overview.data.revision);
    }
  }, [overview.data, draft]);

  const update = useMutation(trpc.config.appClient.update.mutationOptions({
    onSuccess: (saved) => {
      queryClient.setQueryData(trpc.config.appClient.overview.queryKey(), (current) => current ? { ...current, ...saved } : current);
      void queryClient.invalidateQueries(trpc.config.appClient.history.queryFilter());
      setDraft(saved.values);
      setBaseRevision(saved.revision);
      setError(null);
      setConflict(false);
      setNotice(`Saved as revision ${saved.revision}.`);
    },
    onError: (failure) => {
      setConflict(failure.data?.code === "CONFLICT");
      setError(failure.message || "Could not save. Your edits are preserved; try again.");
    },
  }));

  if (overview.isError) return (
    <div className="mt-5 flex flex-wrap items-center gap-3">
      <p role="alert" className="text-sm text-muted-foreground">App settings could not be loaded.</p>
      <Button type="button" variant="outline" onClick={() => { void overview.refetch(); }}>Retry</Button>
    </div>
  );
  if (!overview.data || !draft) return <Skeleton className="mt-5 h-96 rounded-xl" />;

  const validation = appClientConfigSchema.safeParse(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(overview.data.values);
  const busy = update.isPending;
  const setReview = (patch: Partial<AppClientConfig["review"]>) => { setNotice(null); setDraft({ ...draft, review: { ...draft.review, ...patch } }); };
  const setFeedback = (patch: Partial<AppClientConfig["feedback"]>) => { setNotice(null); setDraft({ ...draft, feedback: { ...draft.feedback, ...patch } }); };
  const toggle = <T extends string>(list: readonly T[], value: T, order: readonly T[]) =>
    order.filter((item) => item === value ? !list.includes(value) : list.includes(item));

  const number = <S extends "review" | "feedback">(section: S, key: NumberKey<AppClientConfig[S]>, label: string, step = 1) => (
    <label className="block min-w-0 text-sm">
      <span className="mb-2 block font-medium">{label}</span>
      <Input
        type="number"
        step={step}
        value={String(draft[section][key])}
        onChange={(event) => {
          const value = Number(event.target.value);
          if (section === "review") setReview({ [key]: value } as Partial<AppClientConfig["review"]>);
          else setFeedback({ [key]: value } as Partial<AppClientConfig["feedback"]>);
        }}
        className="tabular-nums"
      />
    </label>
  );
  const check = (checked: boolean, onChange: (value: boolean) => void, label: string) => (
    <label className="flex min-h-11 items-center gap-3 text-sm">
      <input type="checkbox" className="size-4" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || conflict || !dirty || !validation.success) return;
    update.mutate({ expectedRevision: baseRevision, values: validation.data });
  };

  return (
    <form onSubmit={submit} aria-label="App settings" aria-busy={busy} className="mt-5" noValidate>
      <fieldset disabled={busy} className="min-w-0 space-y-4">
        <legend className="text-base font-semibold">Review prompt</legend>
        <p className="text-sm leading-6 text-muted-foreground">
          The app asks the system for its review prompt only when every condition holds, at one of the chosen moments. iOS itself shows it at most three times a year.
        </p>
        {check(draft.review.enabled, (value) => setReview({ enabled: value }), "Ask for reviews")}
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          {number("review", "minDaysSinceInstall", "Days since first launch")}
          {number("review", "minActiveDays", "Days the app was opened")}
          {number("review", "cooldownDays", "Days between prompts")}
          {number("review", "delaySeconds", "Delay after the moment (seconds)", 0.5)}
        </div>
        {check(draft.review.requiresWidgetOrActiveDays, (value) => setReview({ requiresWidgetOrActiveDays: value }), "The widget is placed, or the app was opened on enough days")}
        {check(draft.review.oncePerVersion, (value) => setReview({ oncePerVersion: value }), "At most once per app version")}
        <div>
          <p className="mb-1 text-sm font-medium">Moments</p>
          {REVIEW_TRIGGERS.map((trigger) => (
            <div key={trigger}>{check(draft.review.triggers.includes(trigger), () => setReview({ triggers: toggle(draft.review.triggers, trigger, REVIEW_TRIGGERS) }), TRIGGER_LABELS[trigger])}</div>
          ))}
        </div>
      </fieldset>

      <div className="mt-7 border-t border-border pt-6">
      <fieldset disabled={busy} className="min-w-0 space-y-4">
        <legend className="text-base font-semibold">Feedback form</legend>
        {check(draft.feedback.enabled, (value) => setFeedback({ enabled: value }), "Accept feedback in the app")}
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          {number("feedback", "maxMessageLength", "Longest message (characters)")}
        </div>
        {check(draft.feedback.allowsScreenshot, (value) => setFeedback({ allowsScreenshot: value }), "Allow a screenshot")}
        {!overview.data.screenshotStorageConfigured ? (
          <p className="text-sm text-muted-foreground">Screenshot storage (R2) is not configured on this server, so the app offers no screenshot whatever this says.</p>
        ) : null}
        <div>
          <p className="mb-1 text-sm font-medium">Categories</p>
          {FEEDBACK_CATEGORIES.map((category) => (
            <div key={category}>{check(draft.feedback.categories.includes(category), () => setFeedback({ categories: toggle(draft.feedback.categories, category, FEEDBACK_CATEGORIES) }), CATEGORY_LABELS[category])}</div>
          ))}
        </div>
        <div>
          <p className="mb-1 text-sm font-medium">Also offered where something went wrong</p>
          {FEEDBACK_CONTEXTS.map((context) => (
            <div key={context}>{check(draft.feedback.contextualEntries.includes(context), () => setFeedback({ contextualEntries: toggle(draft.feedback.contextualEntries, context, FEEDBACK_CONTEXTS) }), CONTEXT_LABELS[context])}</div>
          ))}
        </div>
      </fieldset>
      </div>

      <div className="mt-6 border-t border-border pt-4">
        {!validation.success ? <p role="alert" className="mb-3 text-sm text-destructive">{validation.error.issues[0]?.message ?? "Some values are out of range."}</p> : null}
        {conflict ? <p role="alert" className="mb-3 text-sm">These settings changed since you opened them. Reload to see the latest values; your edits will be replaced.</p> : null}
        {error && !conflict ? <p role="alert" className="mb-3 text-sm text-destructive">{error}</p> : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="status" className="text-sm text-muted-foreground">
            {busy ? "Saving…" : notice ?? (dirty ? "Unsaved changes" : overview.data.source === "defaults" ? "Using built-in defaults" : `Revision ${overview.data.revision}${overview.data.updatedAt ? ` · ${formatUtcDateTime(overview.data.updatedAt)}` : ""}`)}
          </p>
          <div className="flex flex-wrap gap-2">
            {conflict ? (
              <Button type="button" variant="outline" onClick={async () => {
                const latest = await overview.refetch();
                if (latest.data) { setDraft(latest.data.values); setBaseRevision(latest.data.revision); setConflict(false); setError(null); }
              }}>Load latest</Button>
            ) : null}
            <Button type="button" variant="ghost" disabled={busy} onClick={() => { setNotice(null); setDraft(overview.data.defaults); }}>
              <RotateCcw aria-hidden="true" /> Recommended defaults
            </Button>
            <Button type="submit" disabled={busy || !dirty || !validation.success || conflict}>
              <Save aria-hidden="true" /> {busy ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      </div>

      {history.data?.length ? (
        <details className="mt-5">
          <summary className="cursor-pointer text-sm font-medium">Recent changes</summary>
          <ol className="mt-3 space-y-3 text-sm">
            {history.data.map((entry) => (
              <li key={entry.revision}>
                <p className="font-medium">Revision {entry.revision} <span className="font-normal text-muted-foreground">· {formatUtcDateTime(entry.createdAt)} · {entry.actorId}</span></p>
                <pre className="mt-1 overflow-x-auto rounded-lg bg-muted/40 p-3 text-xs">{describeChange(entry.before, entry.after)}</pre>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </form>
  );
}

/** One line per changed setting, `section.key: before → after`. */
function describeChange(before: AppClientConfig, after: AppClientConfig) {
  const lines: string[] = [];
  for (const section of ["review", "feedback"] as const) {
    for (const key of Object.keys(after[section]) as (keyof AppClientConfig[typeof section])[]) {
      const a = JSON.stringify(before[section][key]);
      const b = JSON.stringify(after[section][key]);
      if (a !== b) lines.push(`${section}.${String(key)}: ${a} → ${b}`);
    }
  }
  return lines.join("\n") || "No differences";
}
