import type { SettingsSnapshot } from "@northwind/api/settings-store";
import { Button } from "@northwind/ui/components/button";
import { Card } from "@northwind/ui/components/card";
import { Skeleton } from "@northwind/ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DecorateMutationProcedure, DecorateQueryProcedure } from "@trpc/tanstack-react-query";
import { RefreshCw } from "lucide-react";
import { useEffect, useReducer, useState } from "react";

import { SettingsForm, type SettingsSection } from "@/components/admin/settings-form";
import { formatUtcDateTime } from "@/lib/format";
import {
  createSettingsForm,
  settingsFormReducer,
  type SettingsSchema,
  type SettingsValues,
} from "@/lib/settings-form";

type Def<Input, Output> = { input: Input; output: Output; transformer: false; errorShape: any; featureFlags: { keyPrefix: false } };
type Overview<V> = SettingsSnapshot<V> & { defaults: V };
type HistoryEntry<V> = { revision: number; actorId: string; createdAt: string; before: V; after: V };

/** The tRPC procedures of one runtime settings scope (`createSettingsRouter` on the server). */
export type SettingsProcedures<V extends SettingsValues> = {
  overview: DecorateQueryProcedure<Def<void, Overview<V>>>;
  update: DecorateMutationProcedure<Def<{ expectedRevision: number; values: V }, SettingsSnapshot<V>>>;
  history: DecorateQueryProcedure<Def<void, HistoryEntry<V>[]>>;
};

type PanelProps<V extends SettingsValues> = {
  label: string;
  procedures: SettingsProcedures<V>;
  schema: SettingsSchema<V>;
  sections: SettingsSection<V>[];
};

function Editor<V extends SettingsValues>({ snapshot, label, procedures, schema, sections }: PanelProps<V> & { snapshot: Overview<V> }) {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(settingsFormReducer<V>, snapshot, createSettingsForm<V>);
  const [reloading, setReloading] = useState(false);
  useEffect(() => dispatch({ type: "receive", snapshot }), [snapshot]);

  const update = useMutation(procedures.update.mutationOptions({
    onSuccess: async (saved) => {
      await queryClient.cancelQueries(procedures.overview.queryFilter());
      queryClient.setQueryData(procedures.overview.queryKey(), { ...saved, defaults: snapshot.defaults });
      dispatch({ type: "saved", snapshot: saved });
      void queryClient.invalidateQueries(procedures.history.queryFilter());
    },
    onError: (error) => dispatch({
      type: "failed",
      message: error.message || "Could not save settings. Your edits are preserved; try saving again.",
      conflict: error.data?.code === "CONFLICT",
    }),
  }));

  const reload = async () => {
    setReloading(true);
    try {
      // Explicitly fetch: the administrator chose to replace their draft with current server values.
      const saved = await queryClient.fetchQuery({ ...procedures.overview.queryOptions(), staleTime: 0 });
      dispatch({ type: "reloaded", snapshot: saved });
      void queryClient.invalidateQueries(procedures.history.queryFilter());
    } catch {
      dispatch({ type: "failed", message: "Could not load the latest settings. Your edits are preserved; try again." });
    } finally {
      setReloading(false);
    }
  };

  return (
    <SettingsForm
      label={label}
      schema={schema}
      sections={sections}
      state={state}
      pending={update.isPending}
      reloading={reloading}
      onEdit={(key, value) => dispatch({ type: "edit", key, value })}
      onSubmit={(values) => update.mutate({ expectedRevision: state.baseline.revision, values })}
      onDefaults={() => dispatch({ type: "defaults", values: snapshot.defaults })}
      onReload={() => { void reload(); }}
    />
  );
}

function History<V extends SettingsValues>({ procedures, sections }: Pick<PanelProps<V>, "procedures" | "sections">) {
  const history = useQuery(procedures.history.queryOptions());
  const fields = sections.flatMap((section) => section.fields);
  if (history.isPending) return <p role="status" className="mt-4 text-sm text-muted-foreground">Loading recent changes…</p>;
  if (history.isError) return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <p role="alert" className="text-sm text-muted-foreground">Recent changes could not be loaded.</p>
      <Button type="button" variant="outline" onClick={() => { void history.refetch(); }}>Retry</Button>
    </div>
  );
  return history.data.length ? (
    <ol className="mt-4 divide-y divide-border">
      {history.data.map((entry) => (
        <li key={entry.revision} className="py-4 first:pt-0">
          <p className="text-sm font-medium">Revision {entry.revision} <span className="font-normal text-muted-foreground">· {formatUtcDateTime(entry.createdAt)}</span></p>
          <p className="mt-1 break-all text-xs text-muted-foreground">Changed by {entry.actorId}</p>
          <ul className="mt-3 space-y-1 text-sm">
            {fields.filter(({ key }) => entry.before[key] !== entry.after[key]).map(({ key, label }) => (
              <li key={key} className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                <span className="text-muted-foreground">{label}</span>
                <span className="tabular-nums">{entry.before[key]} → {entry.after[key]}</span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  ) : <p className="mt-4 text-sm text-muted-foreground">No settings changes yet.</p>;
}

/** Admin editor for one runtime settings scope: optimistic-concurrency form, status, and audit history. */
export function RuntimeSettingsPanel<V extends SettingsValues>(props: PanelProps<V>) {
  const overview = useQuery(props.procedures.overview.queryOptions());
  const [historyOpen, setHistoryOpen] = useState(false);
  const data = overview.data;

  if (!data) {
    return overview.isError ? (
      <Card className="items-center p-8 text-center">
        <p role="alert" className="font-medium">Settings could not be loaded.</p>
        <Button type="button" variant="outline" disabled={overview.isFetching} onClick={() => { void overview.refetch(); }}>
          <RefreshCw aria-hidden="true" /> {overview.isFetching ? "Loading…" : "Retry"}
        </Button>
      </Card>
    ) : (
      <div aria-busy="true">
        <p role="status" className="sr-only">Loading settings…</p>
        <Skeleton className="h-80 rounded-2xl" />
      </div>
    );
  }

  return (
    <>
      <Editor {...props} snapshot={data} />
      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        {data.source === "deployment" ? "Using deployment values. Your first save stores these settings in Admin." : `Revision ${data.revision}`}
        {data.updatedAt ? ` · Updated ${formatUtcDateTime(data.updatedAt)}` : ""}
      </p>
      {overview.isError ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-destructive">Could not refresh settings. Your draft is preserved.</p>
          <Button type="button" variant="outline" disabled={overview.isFetching} onClick={() => { void overview.refetch(); }}>
            {overview.isFetching ? "Loading…" : "Retry"}
          </Button>
        </div>
      ) : null}
      <details className="mt-4 rounded-2xl border border-border bg-card px-5 py-4 sm:px-6" onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer text-sm font-medium">Recent changes</summary>
        {historyOpen ? <History procedures={props.procedures} sections={props.sections} /> : null}
      </details>
    </>
  );
}
