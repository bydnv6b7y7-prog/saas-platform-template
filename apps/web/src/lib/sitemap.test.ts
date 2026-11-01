import { describe, expect, test } from "bun:test";

import { buildSitemapXml } from "./sitemap";

describe("sitemap XML", () => {
  test("keeps canonical internal URLs, deduplicates them, and preserves real lastmod", () => {
    const xml = buildSitemapXml([
      { path: "/rankings" },
      { path: "/app/123", lastModified: "2026-09-01T12:00:00Z" },
      { path: "/app/123", lastModified: "2020-01-01T00:00:00Z" },
      { path: "https://example.com/not-internal" },
      { path: "//example.com/not-internal" },
    ]);

    expect(xml.match(/<loc>[^<]*\/app\/123<\/loc>/g)).toHaveLength(1);
    expect(xml).toContain(
      "<lastmod>2026-09-01T12:00:00.000Z</lastmod>",
    );
    expect(xml).not.toContain("not-internal");
  });

  test("omits invalid lastmod instead of publishing a false timestamp", () => {
    const xml = buildSitemapXml([
      { path: "/app/123", lastModified: "not-a-date" },
    ]);
    expect(xml).not.toContain("<lastmod>");
  });
});
