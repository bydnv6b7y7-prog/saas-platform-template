import { env } from "@northwind/env/web";

function withoutTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Public API in the browser; optional service-network API during SSR. */
export function getApiBaseURL(): string {
  const processEnv = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
  const configuredUrl =
    typeof window === "undefined"
      ? (processEnv?.SERVER_URL ?? env.VITE_SERVER_URL)
      : env.VITE_SERVER_URL;

  try {
    const protocol = new URL(configuredUrl).protocol;
    if (protocol !== "http:" && protocol !== "https:") throw new Error();
  } catch {
    throw new Error("API URL must be an absolute http(s) URL");
  }
  return withoutTrailingSlash(configuredUrl);
}
