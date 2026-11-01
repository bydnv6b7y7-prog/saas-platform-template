import { env } from "@northwind/env/web";
import { Button } from "@northwind/ui/components/button";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { AnalyticsConsent } from "@/lib/analytics-consent";
import { setAnalyticsConsentDecision } from "@/lib/analytics";
import {
  useAnalyticsConsent,
  useAnalyticsConsentPolicy,
  useAnalyticsConsentPreference,
  useAnalyticsPrivacySignal,
} from "@/lib/use-analytics-consent";

function allowAnalytics(): void {
  setAnalyticsConsentDecision("granted");
}

function declineAnalytics(): void {
  setAnalyticsConsentDecision("denied");
}

function ConsentButtons({
  consent,
  privacySignal,
}: {
  consent: AnalyticsConsent;
  privacySignal: boolean;
}) {
  if (consent === "granted") {
    return (
      <Button type="button" variant="outline" onClick={declineAnalytics}>
        Turn off browser analytics
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {consent === "pending" ? (
        <Button type="button" variant="outline" onClick={declineAnalytics}>
          Decline browser analytics
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        disabled={privacySignal}
        onClick={allowAnalytics}
      >
        Allow browser analytics
      </Button>
    </div>
  );
}

export function AnalyticsConsentBanner() {
  const consent = useAnalyticsConsent();
  const privacySignal = useAnalyticsPrivacySignal();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (
    !mounted ||
    !env.VITE_POSTHOG_PROJECT_TOKEN ||
    consent !== "pending"
  ) {
    return null;
  }

  return (
    <aside
      aria-label="Analytics consent"
      className="fixed inset-x-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-[70] mx-auto max-w-3xl rounded-2xl border border-border bg-card p-4 shadow-xl md:bottom-5 sm:p-5"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-xl">
          <h2 className="font-semibold tracking-tight">Optional analytics</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            May we use PostHog to understand page visits, product usage, and
            acquisition attribution? We use local storage rather than cookies,
            do not use session replay, and send no optional browser event before
            you choose.
          </p>
          <Link
            to="/privacy"
            hash="analytics-controls"
            className="mt-1 inline-flex min-h-8 items-center text-sm font-medium text-brand hover:underline"
          >
            Privacy details
          </Link>
        </div>
        <ConsentButtons consent={consent} privacySignal={privacySignal} />
      </div>
    </aside>
  );
}

export function AnalyticsConsentSettings() {
  const consent = useAnalyticsConsent();
  const policy = useAnalyticsConsentPolicy();
  const preference = useAnalyticsConsentPreference();
  const privacySignal = useAnalyticsPrivacySignal();
  const configured = Boolean(env.VITE_POSTHOG_PROJECT_TOKEN);

  const status = !configured
    ? "Browser analytics is not configured."
    : privacySignal
      ? "Browser analytics is off because your browser sends a Global Privacy Control or Do Not Track signal."
      : consent === "granted"
        ? preference === "pending" && policy === "opt_out"
          ? "Optional browser analytics is on by default under the active regional policy."
          : "Optional browser analytics is on because you allowed it."
        : consent === "denied"
          ? "Optional browser analytics is off."
          : "No analytics choice has been saved, so optional browser analytics remains off.";
  const guidance = !configured
    ? "No action is required."
    : privacySignal
      ? "This site will continue honoring that browser setting."
      : "You can change this choice at any time.";

  return (
    <section id="analytics-controls" className="scroll-mt-24">
      <h2>Your analytics choice</h2>
      <p>{status} {guidance}</p>
      {configured ? (
        <div className="mt-4">
          <ConsentButtons consent={consent} privacySignal={privacySignal} />
        </div>
      ) : null}
    </section>
  );
}
