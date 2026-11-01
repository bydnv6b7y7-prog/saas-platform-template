// Dependency-free so release workflows can read the defaults before installing packages.
/** Browser analytics endpoint: a same-site PostHog reverse proxy, or the ingestion host when there is none. */
export const POSTHOG_BROWSER_PROXY_HOST = "https://ingest.northwind.dev";
/** Server-side ingestion (US region). */
export const POSTHOG_INGESTION_HOST = "https://us.i.posthog.com";
export const POSTHOG_UI_HOST = "https://us.posthog.com";
