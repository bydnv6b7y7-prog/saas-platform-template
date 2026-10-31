import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

import { isIndexingEnabled } from "@/lib/seo";
import { buildSitemapXml } from "@/lib/sitemap";
import { productSitemapEntries } from "@/product";

const PLATFORM_PATHS = ["/pricing", "/privacy", "/terms"] as const;

async function sitemapXml(): Promise<string> {
  if (!isIndexingEnabled()) return buildSitemapXml([]);

  return buildSitemapXml([
    ...(await productSitemapEntries()),
    ...PLATFORM_PATHS.map((path) => ({ path })),
  ]);
}

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () =>
        new Response(await sitemapXml(), {
          headers: {
            "Cache-Control": "public, max-age=300, s-maxage=300, must-revalidate",
            "Content-Type": "application/xml; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
          },
        }),
    },
  },
});
