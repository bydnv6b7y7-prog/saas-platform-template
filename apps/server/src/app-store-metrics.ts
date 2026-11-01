import type { AppStoreService } from "@northwind/better-auth-app-store";

export async function appStoreMetrics(service: Pick<AppStoreService, "metrics"> | null): Promise<string[]> {
  const result = ["# TYPE app_store_configured gauge", `app_store_configured ${service ? 1 : 0}`];
  if (!service) return result;
  try {
    const { counters, ...gauges } = await service.metrics();
    result.push("app_store_metrics_available 1");
    for (const [key, value] of Object.entries(gauges)) {
      const name = `app_store_${key.replace(/[A-Z]/g, character => `_${character.toLowerCase()}`)}`;
      result.push(`# TYPE ${name} gauge`, `${name} ${value}`);
    }
    result.push("# TYPE app_store_events_total counter");
    for (const [key, value] of Object.entries(counters)) {
      const [event, code = "none"] = key.split(":");
      if (/^[A-Za-z_]+$/.test(event!) && /^[A-Z_a-z]+$/.test(code)) result.push(`app_store_events_total{event="${event}",code="${code}"} ${value}`);
    }
  } catch { result.push("app_store_metrics_available 0"); }
  return result;
}
