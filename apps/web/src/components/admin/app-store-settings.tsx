import type { AppStoreAdminAction, AppStoreAdminOverview } from "@northwind/api/app-store-admin";
import { APP_STORE_ENVIRONMENTS } from "@northwind/env/app-store";
import { Button } from "@northwind/ui/components/button";
import { Skeleton } from "@northwind/ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, RefreshCw } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";

import {
  appStoreTestStatusMessage,
  appStoreTestStorageKey,
  appStoreTestEnvironmentChoices,
  canConfirmAppStoreTestWasNotSent,
  formatAppStoreDuration,
  isUnresolvedAppStoreTest,
  latestAppStoreTestAttempt,
  nextAppStoreTestRequest,
  parseAppStoreTestAttempt,
  type AppStoreTestAttempt,
} from "@/lib/app-store-settings";
import { formatUtcDateTime } from "@/lib/format";
import { useTRPC } from "@/utils/trpc";

type Environment = AppStoreAdminAction["environment"];
type Attempts = Partial<Record<Environment, AppStoreTestAttempt>>;

const CREDENTIAL_LABELS = {
  APP_STORE_ISSUER_ID: "Issuer ID",
  APP_STORE_KEY_ID: "Key ID",
  APP_STORE_PRIVATE_KEY_BASE64: "Private key",
};

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words text-sm font-medium">{children}</dd></div>;
}

function NotificationAddress({ url }: { url: string | null }) {
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setNotice({ message: "Notification URL copied.", error: false });
    } catch {
      setNotice({ message: "Could not copy the URL. Select and copy it manually.", error: true });
    }
  };
  return (
    <div className="mt-5">
      <h3 className="text-sm font-medium">Server notification URL</h3>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">Use this URL with Version 2 notifications in App Store Connect for each allowed environment.</p>
      {url ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-muted/40 px-3 py-2">
          <code className="min-w-0 flex-1 break-all text-xs leading-5 select-all">{url}</code>
          <Button type="button" variant="ghost" size="sm" aria-label="Copy notification URL" onClick={() => { void copy(); }}><Copy aria-hidden="true" /> Copy</Button>
        </div>
      ) : <p className="mt-2 text-sm text-muted-foreground">Unavailable. Check the API's public URL in deployment settings.</p>}
      <p aria-live="polite" className={`mt-1 text-xs ${notice?.error ? "text-destructive" : "text-muted-foreground"}`}>{notice?.message}</p>
    </div>
  );
}

export function AppStoreDiagnostics({ diagnostics }: { diagnostics: AppStoreAdminOverview["diagnostics"] }) {
  return (
    <section aria-labelledby="app-store-diagnostics-title" className="mt-6 border-t border-border pt-5">
      <h3 id="app-store-diagnostics-title" className="text-sm font-semibold">Notification processing</h3>
      <p className="mt-1 text-xs text-muted-foreground">Database observations · {formatUtcDateTime(diagnostics.observedAt)}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">Counts describe stored records. Empty queues do not confirm notification delivery or Apple connectivity.</p>
      <div className="mt-4 space-y-5">
        {diagnostics.environments.map((item) => (
          <div key={item.environment}>
            <p className="text-sm font-medium">{item.environment} <span className="ml-1 font-normal text-muted-foreground">· Processing {item.processingEnabled ? "enabled" : "disabled"}</span></p>
            {!item.available || !item.metrics ? <p className="mt-2 text-sm text-muted-foreground">Diagnostics unavailable. Refresh to try again.</p> : (
              <>
                {!item.processingEnabled ? <p className="mt-1 text-xs leading-5 text-muted-foreground">Stored records are shown. Incoming notifications and reconciliation are not running in this environment.</p> : null}
                <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">
                  <Detail label="Queued notifications"><span className="tabular-nums">{item.metrics.pendingNotifications}</span></Detail>
                  <Detail label="Failed notifications"><span className="tabular-nums">{item.metrics.deadNotifications}</span></Detail>
                  <Detail label="Blocked account links"><span className="tabular-nums">{item.metrics.blockedTokens}</span></Detail>
                  <Detail label="Stale subscriptions"><span className="tabular-nums">{item.metrics.staleSubscriptions}</span></Detail>
                </dl>
                <details className="mt-3">
                  <summary className="w-fit cursor-pointer text-xs text-muted-foreground">More processing details</summary>
                  <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-3">
                    <Detail label="Oldest queued notification">{item.metrics.pendingNotifications ? formatAppStoreDuration(item.metrics.oldestNotificationAgeSeconds) : "No queued notifications"}</Detail>
                    <Detail label="Pending account links">{item.metrics.pendingTokens}</Detail>
                    <Detail label="History coverage gaps">{item.metrics.historyCoverageGaps}</Detail>
                    <Detail label="Unfinished history scopes">{item.metrics.unfinishedHistoryScopes}</Detail>
                    <Detail label="History lag">{item.metrics.historyLagSeconds > 0 ? formatAppStoreDuration(item.metrics.historyLagSeconds) : "No lag recorded"}</Detail>
                  </dl>
                </details>
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function loadAttempts(bundleId: string, actorId: string): Attempts {
  const attempts: Attempts = {};
  if (typeof window === "undefined") return attempts;
  for (const environment of APP_STORE_ENVIRONMENTS) {
    try {
      const value = parseAppStoreTestAttempt(sessionStorage.getItem(appStoreTestStorageKey(bundleId, actorId, environment)), environment);
      if (value) attempts[environment] = value;
    } catch { /* Keep in-memory state when browser storage is unavailable. */ }
  }
  return attempts;
}

export function AppStoreTestNotification({ data, actorId, stale }: { data: AppStoreAdminOverview; actorId: string; stale: boolean }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [selection, setSelected] = useState<Environment | "">(data.allowedEnvironments.length === 1 ? data.allowedEnvironments[0]! : "");
  const [attempts, setAttempts] = useState(() => loadAttempts(data.application.bundleId, actorId));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preparedNew, setPreparedNew] = useState(false);
  const submitting = useRef(false);
  const environmentChoices = appStoreTestEnvironmentChoices(data.allowedEnvironments, attempts);
  const selected = environmentChoices.some(({ environment }) => environment === selection) ? selection
    : environmentChoices.length === 1 ? environmentChoices[0]!.environment
    : data.allowedEnvironments.length === 1 ? data.allowedEnvironments[0]! : "";
  const savedAttempt = selected ? attempts[selected] : null;
  const auditedAttempt = savedAttempt ? data.audit.items.find((item) => item.requestId === savedAttempt.requestId && item.actorId === actorId && item.environment === selected) : undefined;
  const attempt = latestAppStoreTestAttempt(savedAttempt, auditedAttempt);
  const unresolved = isUnresolvedAppStoreTest(attempt);
  const recordedAttempt = attempt && ["pending", "unknown", "accepted", "failed"].includes(attempt.status);
  const record = (value: AppStoreTestAttempt) => {
    setAttempts((previous) => ({ ...previous, [value.environment]: value }));
    try {
      sessionStorage.setItem(appStoreTestStorageKey(data.application.bundleId, actorId, value.environment), JSON.stringify(value));
    } catch { /* The mounted panel still preserves the request ID across retries. */ }
  };
  const mutation = useMutation(trpc.config.appStore.testNotification.mutationOptions({ retry: false }));
  const deploymentReady = data.enabled && data.configured && !data.configurationError && !stale;
  const selectedAllowed = selected !== "" && data.allowedEnvironments.includes(selected);
  const canSend = deploymentReady && selectedAllowed;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current || !selected || (!canSend && !attempt)) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    setPreparedNew(false);
    try {
      if (attempt && (!canSend || recordedAttempt)) {
        const recorded = await queryClient.fetchQuery({
          ...trpc.config.appStore.testRequest.queryOptions({ requestId: attempt.requestId, environment: selected }),
          staleTime: 0,
        });
        if (recorded) record(recorded);
        else setError("No server record was found for this request. Its request ID is preserved; no test was sent.");
        return;
      }
      const input = nextAppStoreTestRequest(attempt, selected, () => crypto.randomUUID());
      record({ ...input, status: "unconfirmed", updatedAt: new Date().toISOString() });
      try {
        const result = await mutation.mutateAsync(input);
        record(result);
        void queryClient.invalidateQueries(trpc.config.appStore.overview.queryFilter());
      } catch (cause) {
        const code = typeof cause === "object" && cause !== null && "data" in cause
          ? (cause.data as { code?: string } | undefined)?.code : undefined;
        if (canConfirmAppStoreTestWasNotSent(attempt, code)) {
          record({ ...input, status: "not_sent", updatedAt: new Date().toISOString() });
        }
        setError(cause instanceof Error ? cause.message : "Could not confirm the request. Your request ID has been kept for retry.");
      }
    } catch {
      setError("Could not prepare or check the request. Your request ID is preserved; try again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const prepareNew = () => {
    if (!selected || busy || !canSend || !attempt || !["unknown", "accepted", "failed"].includes(attempt.status)) return;
    setAttempts((previous) => { const next = { ...previous }; delete next[selected]; return next; });
    try { sessionStorage.removeItem(appStoreTestStorageKey(data.application.bundleId, actorId, selected)); } catch { /* The local attempt is cleared; audit records remain on the server. */ }
    setError(null);
    setPreparedNew(true);
  };

  return (
    <details className="mt-6 border-t border-border pt-5">
      <summary className="cursor-pointer text-sm font-medium">Advanced diagnostics</summary>
      <form onSubmit={(event) => { void submit(event); }} aria-label="App Store test notification" aria-busy={busy} className="mt-4">
        <h3 className="text-sm font-semibold">Test notification</h3>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">Optional: ask Apple to send a test notification to check connectivity. This does not create a purchase or subscription. An accepted request confirms submission to Apple; received notifications below show what reached this server.</p>
        {!deploymentReady && !unresolved ? <p className="mt-2 text-xs leading-5 text-muted-foreground">{stale ? "Refresh the latest configuration before sending a test." : "Enable processing and complete the credentials in deployment settings before sending a test."}</p> : null}
        {environmentChoices.length > 1 ? <fieldset disabled={busy} className="mt-4">
          <legend className="mb-2 text-xs font-medium">Apple environment</legend>
          <div className="flex flex-wrap gap-3">
            {environmentChoices.map(({ environment, statusOnly }) => (
              <label key={environment} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-border px-3 text-sm has-checked:border-brand/40 has-checked:bg-brand/5">
                <input type="radio" name="app-store-test-environment" value={environment} checked={selected === environment} onChange={() => { setSelected(environment); setError(null); setPreparedNew(false); }} className="accent-current" />
                {environment}
                {statusOnly ? <span className="text-xs text-muted-foreground">· Status only</span> : null}
              </label>
            ))}
          </div>
        </fieldset> : <p className="mt-4 text-xs text-muted-foreground">Apple environment · {selected || "None"}{environmentChoices[0]?.statusOnly ? " · Status only" : ""}</p>}
        {selected && !selectedAllowed ? <p className="mt-2 text-xs leading-5 text-muted-foreground">This environment is no longer enabled. You can check saved requests, but cannot send a new test.</p> : null}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button type="submit" variant="outline" disabled={busy || !selected || (!canSend && !attempt)}>
            {busy ? "Checking request…" : recordedAttempt || (!canSend && attempt) ? "Check request status" : unresolved ? "Check / retry this request" : "Send test notification"}
          </Button>
          {attempt && ["unknown", "accepted", "failed"].includes(attempt.status) ? <Button type="button" variant="ghost" disabled={busy || !canSend} onClick={prepareNew}>Start a new test</Button> : null}
          {!selected ? <p className="text-xs text-muted-foreground">Choose an environment first.</p> : null}
        </div>
        <div aria-live="polite" aria-atomic="true" className="mt-3 text-xs leading-5">
          {busy ? <p className="text-muted-foreground">Waiting for the server to confirm the request status…</p> : attempt ? (
            <div className="text-muted-foreground">
              <p>{appStoreTestStatusMessage(attempt.status)}</p>
              <p className="mt-1 break-all">{attempt.environment} · {formatUtcDateTime(attempt.updatedAt)} · Request {attempt.requestId}</p>
            </div>
          ) : preparedNew ? <p className="text-muted-foreground">Ready for a new test. Nothing has been sent; use “Send test notification” to submit it. Previous requests remain in history.</p> : null}
        </div>
        {error ? <p role="alert" className="mt-2 text-xs leading-5 text-destructive">{error}</p> : null}
      </form>
    </details>
  );
}

export function AppStoreHistory({ notifications, audit }: Pick<AppStoreAdminOverview, "notifications" | "audit">) {
  return (
    <div className="mt-6 divide-y divide-border border-t border-border">
      <details className="py-4">
        <summary className="cursor-pointer text-sm font-medium">Received notifications <span className="font-normal text-muted-foreground">· Recent 20</span></summary>
        {!notifications.available ? <p className="mt-3 text-sm text-muted-foreground">Notification history is unavailable.</p> : !notifications.items.length ? <p className="mt-3 text-sm text-muted-foreground">No notifications have been recorded for this app.</p> : (
          <ol className="mt-3 divide-y divide-border">
            {notifications.items.map((item) => (
              <li key={item.id} className="py-3 first:pt-0">
                <p className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="font-medium">{item.type ?? "Unknown notification"}</span><span className="text-xs text-muted-foreground">{item.environment} · {item.status}</span></p>
                <p className="mt-1 text-xs text-muted-foreground">Received {formatUtcDateTime(item.receivedAt)}{item.processedAt ? ` · Processed ${formatUtcDateTime(item.processedAt)}` : " · Not processed"}</p>
                <p className="mt-1 break-all text-xs text-muted-foreground">{item.id} · {item.attempts} processing attempts{item.errorCode ? ` · ${item.errorCode}` : ""}</p>
              </li>
            ))}
          </ol>
        )}
      </details>
      <details className="py-4">
        <summary className="cursor-pointer text-sm font-medium">Test request history <span className="font-normal text-muted-foreground">· Recent 20</span></summary>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">Requests are audited separately from received notifications. An accepted request does not confirm delivery.</p>
        {!audit.available ? <p className="mt-3 text-sm text-muted-foreground">Test request history is unavailable.</p> : !audit.items.length ? <p className="mt-3 text-sm text-muted-foreground">No test requests have been recorded for this app.</p> : (
          <ol className="mt-3 divide-y divide-border">
            {audit.items.map((item) => (
              <li key={item.requestId} className="py-3 first:pt-0">
                <p className="text-sm font-medium">{item.environment} <span className="font-normal text-muted-foreground">· {item.status === "accepted" ? "Accepted by Apple" : item.status === "unknown" ? "Outcome unknown" : item.status}</span></p>
                <p className="mt-1 text-xs text-muted-foreground">Requested {formatUtcDateTime(item.createdAt)} · Updated {formatUtcDateTime(item.updatedAt)}</p>
                <p className="mt-1 break-all text-xs text-muted-foreground">By {item.actorId} · Request {item.requestId}{item.errorCode ? ` · ${item.errorCode}` : ""}</p>
              </li>
            ))}
          </ol>
        )}
      </details>
    </div>
  );
}

export function AppStoreSettings({ actorId }: { actorId: string }) {
  const trpc = useTRPC();
  const overview = useQuery(trpc.config.appStore.overview.queryOptions());
  const data = overview.data;
  if (!data) return overview.isError ? (
    <div className="mt-5 flex flex-wrap items-center gap-3">
      <p role="alert" className="text-sm text-muted-foreground">App Store settings could not be loaded.</p>
      <Button type="button" variant="outline" disabled={overview.isFetching} onClick={() => { void overview.refetch(); }}>{overview.isFetching ? "Loading…" : "Retry"}</Button>
    </div>
  ) : <div className="mt-5" aria-busy="true"><p role="status" className="sr-only">Loading App Store settings…</p><Skeleton className="h-64 rounded-xl" /></div>;

  const missing = data.credentials.filter((credential) => !credential.present);
  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Processing {data.enabled && data.configured ? "enabled" : "disabled"}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{data.enabled && data.configured ? "Purchase verification, account linking and subscription updates are enabled." : "The server is not processing purchase verification, restores or subscription updates."}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" disabled={overview.isFetching} onClick={() => { void overview.refetch(); }}><RefreshCw aria-hidden="true" /> {overview.isFetching ? "Refreshing…" : "Refresh status"}</Button>
      </div>
      {overview.isError ? <p role="alert" className="mt-3 text-sm text-destructive">Refresh failed. The information below is from the last successful observation and may be out of date.</p> : null}
      <div className="mt-4 rounded-xl bg-muted/35 p-4">
        <p className="text-sm font-medium">{missing.length ? `${missing.length} credential${missing.length > 1 ? "s" : ""} missing` : "All three credentials are present"}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">Credential presence does not verify access with Apple. Manage credentials and processing settings in Dokploy.</p>
        <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs">
          {data.credentials.map((credential) => <li key={credential.key}>{CREDENTIAL_LABELS[credential.key]} <span className="text-muted-foreground">· {credential.present ? "Present" : "Missing"}</span></li>)}
        </ul>
        {data.configurationError ? <p role="alert" className="mt-3 text-xs text-destructive">The deployment configuration is invalid. Check its values before enabling processing.</p> : null}
      </div>

      <NotificationAddress url={data.notificationUrl} />

      <details className="mt-4 border-t border-border pt-4">
        <summary className="cursor-pointer text-sm font-medium">Application and products <span className="font-normal text-muted-foreground">· {data.application.name}</span></summary>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">Shared application configuration, updated with a code release.</p>
        <dl className="mt-3 grid gap-x-5 gap-y-4 sm:grid-cols-2">
          <Detail label="Bundle ID">{data.application.bundleId}</Detail>
          <Detail label="App Apple ID">{data.application.appAppleId}</Detail>
          <Detail label="Subscription group">{data.application.subscriptionGroupId}</Detail>
          <Detail label="Allowed environments">{data.allowedEnvironments.join(", ") || "None"}</Detail>
        </dl>
        <ul className="mt-4 divide-y divide-border">
          {data.application.products.map((product) => <li key={product.productId} className="flex flex-wrap justify-between gap-x-5 gap-y-1 py-2 text-xs"><span>{product.displayName} <span className="ml-1 text-muted-foreground">· {product.productId}</span></span><span className="text-muted-foreground">{product.entitlement}</span></li>)}
        </ul>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">These products grant the app's subscription entitlement. App Store Connect controls pricing and availability.</p>
      </details>

      <AppStoreDiagnostics diagnostics={data.diagnostics} />
      <AppStoreTestNotification key={actorId} data={data} actorId={actorId} stale={overview.isError} />
      <AppStoreHistory notifications={data.notifications} audit={data.audit} />

      <details className="border-t border-border pt-4">
        <summary className="cursor-pointer text-xs text-muted-foreground">Maintenance intervals · Advanced</summary>
        <dl className="mt-3 grid gap-4 sm:grid-cols-2">
          <Detail label="Reverification interval">{formatAppStoreDuration(data.maintenance.reverifyIntervalSeconds)}</Detail>
          <Detail label="Reconciliation interval">{formatAppStoreDuration(data.maintenance.reconcileIntervalSeconds)}</Detail>
        </dl>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">Intervals apply while processing is enabled. A disabled environment retains its stored records.</p>
      </details>
    </div>
  );
}
