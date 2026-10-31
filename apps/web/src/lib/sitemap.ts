import { absoluteUrl } from "./seo";

export type SitemapEntry = {
  path: string;
  lastModified?: string;
};

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function validLastModified(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function buildSitemapXml(entries: readonly SitemapEntry[]): string {
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const entry of entries) {
    if (!entry.path.startsWith("/") || entry.path.startsWith("//")) continue;
    const location = absoluteUrl(entry.path);
    if (seen.has(location)) continue;
    seen.add(location);

    const lastModified = validLastModified(entry.lastModified);
    urls.push(
      `  <url><loc>${escapeXml(location)}</loc>${lastModified ? `<lastmod>${lastModified}</lastmod>` : ""}</url>`,
    );
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}
