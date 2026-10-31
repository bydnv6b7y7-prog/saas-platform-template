import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

import { absoluteUrl, isIndexingEnabled } from "@/lib/seo";

function robotsTxt(): string {
  if (!isIndexingEnabled()) {
    return "User-agent: *\nDisallow: /\n";
  }

  return [
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${absoluteUrl("/sitemap.xml")}`,
    "",
  ].join("\n");
}

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: () =>
        new Response(robotsTxt(), {
          headers: {
            "Cache-Control": "public, max-age=300, s-maxage=300, must-revalidate",
            "Content-Type": "text/plain; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
          },
        }),
    },
  },
});
