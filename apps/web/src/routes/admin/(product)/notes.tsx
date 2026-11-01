import { Button } from "@northwind/ui/components/button";
import { Skeleton } from "@northwind/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { AdminNav } from "@/components/admin/admin-nav";
import { formatEnUsNumber } from "@/lib/format";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/admin/(product)/notes")({
  component: AdminNotesPage,
});

/** Totals only: administrators never see note contents or files. */
function AdminNotesPage() {
  const trpc = useTRPC();
  const stats = useQuery(trpc.notes.adminStats.queryOptions());
  const rows = stats.data ? [
    ["Notes", formatEnUsNumber(stats.data.notes)],
    ["Authors", formatEnUsNumber(stats.data.authors)],
    ["Attachments", formatEnUsNumber(stats.data.attachments)],
    ["Attachment storage", `${(stats.data.bytes / 1024 / 1024).toFixed(1)} MB`],
    ["Uploads awaiting confirmation", formatEnUsNumber(stats.data.pending)],
  ] : [];

  return (
    <div className="page-shell max-w-5xl">
      <AdminNav />
      <header className="mb-7">
        <p className="text-sm font-medium text-brand">Administration</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">Notes</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">
          Usage of the notes example. Contents stay private to each user.
        </p>
      </header>
      {stats.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : stats.isError ? (
        <div role="alert" className="rounded-xl border border-destructive/40 p-4 text-sm">
          Totals could not be loaded.{" "}
          <Button variant="link" className="h-auto p-0" onClick={() => stats.refetch()}>Try again</Button>
        </div>
      ) : (
        <dl className="grid gap-3 sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="rounded-xl border border-border bg-card p-4">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
