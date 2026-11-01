import { operationalSettingsSchema } from "@northwind/env/operational-settings";
import { Skeleton } from "@northwind/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";

import { AdminNav } from "@/components/admin/admin-nav";
import { operationalSettingsSections } from "@/components/admin/operational-settings";
import { RuntimeSettingsPanel } from "@/components/admin/runtime-settings-panel";
import { productAdminSettings } from "@/product";
import { useTRPC } from "@/utils/trpc";

const AppStoreSettings = lazy(() => import("@/components/admin/app-store-settings").then(
  (module) => ({ default: module.AppStoreSettings }),
));
const AppClientSettings = lazy(() => import("@/components/admin/app-client-settings").then(
  (module) => ({ default: module.AppClientSettings }),
));

export const Route = createFileRoute("/admin/config")({
  component: AdminSettingsPage,
});

function AdminSettingsPage() {
  const trpc = useTRPC();
  const { user } = Route.useRouteContext();
  const [productOpen, setProductOpen] = useState<Record<string, boolean>>({});
  const [appStoreLoaded, setAppStoreLoaded] = useState(false);
  const [appClientLoaded, setAppClientLoaded] = useState(false);

  return (
    <div className="page-shell max-w-4xl">
      <AdminNav />
      <header className="mb-7">
        <p className="text-sm font-medium text-brand">Administration</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">Settings</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">
          Manage assistant usage limits, subscriptions and client configuration.
        </p>
      </header>

      <RuntimeSettingsPanel
        label="Operational settings"
        procedures={trpc.config.operations}
        schema={operationalSettingsSchema}
        sections={operationalSettingsSections}
      />

      <details className="mt-4 rounded-2xl border border-border bg-card px-5 py-4 sm:px-6" onToggle={(event) => { if (event.currentTarget.open) setAppStoreLoaded(true); }}>
        <summary className="cursor-pointer text-sm font-medium">App Store subscriptions <span className="ml-1 font-normal text-muted-foreground">· Connection and diagnostics</span></summary>
        {appStoreLoaded ? <Suspense fallback={<Skeleton className="mt-5 h-64 rounded-xl" />}><AppStoreSettings key={user.id} actorId={user.id} /></Suspense> : null}
      </details>

      <details className="mt-4 rounded-2xl border border-border bg-card px-5 py-4 sm:px-6" onToggle={(event) => { if (event.currentTarget.open) setAppClientLoaded(true); }}>
        <summary className="cursor-pointer text-sm font-medium">iOS app <span className="ml-1 font-normal text-muted-foreground">· Review prompt and feedback form</span></summary>
        {appClientLoaded ? <Suspense fallback={<Skeleton className="mt-5 h-64 rounded-xl" />}><AppClientSettings /></Suspense> : null}
      </details>

      {productAdminSettings.map((setting) => (
        <details key={setting.title} className="mt-4 rounded-2xl border border-border bg-card px-5 py-4 sm:px-6" onToggle={(event) => { const open = event.currentTarget.open; setProductOpen((current) => ({ ...current, [setting.title]: open })); }}>
          <summary className="cursor-pointer text-sm font-medium">{setting.title} <span className="ml-1 font-normal text-muted-foreground">· {setting.detail}</span></summary>
          {productOpen[setting.title] ? <Suspense fallback={<Skeleton className="mt-5 h-48 rounded-2xl" />}><div className="mt-5"><setting.Component /></div></Suspense> : null}
        </details>
      ))}
    </div>
  );
}
