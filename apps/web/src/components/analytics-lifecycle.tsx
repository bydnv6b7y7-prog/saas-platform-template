import { useEffect } from "react";
import { useLocation } from "@tanstack/react-router";

import {
  captureAnalyticsPageview,
  disableAnalytics,
  suspendAnalyticsIdentity,
} from "@/lib/analytics";
import { authClient } from "@/lib/auth-client";
import { useAnalyticsConsent } from "@/lib/use-analytics-consent";

export function AnalyticsLifecycle() {
  const session = authClient.useSession();
  const consent = useAnalyticsConsent();
  const pathname = useLocation({ select: (location) => location.pathname });

  useEffect(() => {
    if (consent !== "granted") disableAnalytics();
  }, [consent]);

  useEffect(() => {
    if (consent !== "granted" || session.isPending || session.error) {
      suspendAnalyticsIdentity();
      return;
    }
    captureAnalyticsPageview(session.data?.user.id);
  }, [
    consent,
    pathname,
    session.data?.user.id,
    session.error,
    session.isPending,
  ]);

  return null;
}
