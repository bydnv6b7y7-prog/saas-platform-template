import { env } from "@northwind/env/web";
import { productSeo } from "@/product";


const INDEX_ROBOTS =
  "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1";
const NO_INDEX_ROBOTS = "noindex, nofollow, noarchive";

function siteOrigin(): string {
  const url = new URL(env.VITE_WEB_URL);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

const SITE_ORIGIN = siteOrigin();

export function absoluteUrl(path: string): string {
  return new URL(path, `${SITE_ORIGIN}/`).toString();
}

export function isIndexingEnabled(): boolean {
  return env.VITE_ENABLE_INDEXING === "true";
}

type SeoHeadOptions = {
  title?: string;
  description?: string;
  path: string;
  indexable?: boolean;
  canonical?: boolean;
  image?: {
    url: string;
    alt: string;
  };
};

export function createSeoHead({
  title,
  description = productSeo.description,
  path,
  indexable = true,
  canonical = true,
  image,
}: SeoHeadOptions) {
  const pageTitle = title
    ? `${title} | ${env.VITE_BRAND_NAME}`
    : `${productSeo.title} | ${env.VITE_BRAND_NAME}`;
  const url = absoluteUrl(path);
  const robots = indexable && isIndexingEnabled() ? INDEX_ROBOTS : NO_INDEX_ROBOTS;
  const meta: Record<string, string>[] = [
    { title: pageTitle },
    { name: "description", content: description },
    { name: "robots", content: robots },
    { name: "googlebot", content: robots },
    { property: "og:type", content: "website" },
    { property: "og:locale", content: "en_US" },
    { property: "og:site_name", content: env.VITE_BRAND_NAME },
    { property: "og:title", content: pageTitle },
    { property: "og:description", content: description },
    { property: "og:url", content: url },
    { name: "twitter:card", content: "summary" },
    { name: "twitter:title", content: pageTitle },
    { name: "twitter:description", content: description },
  ];
  if (image) {
    meta.push(
      { property: "og:image", content: image.url },
      { property: "og:image:alt", content: image.alt },
      { name: "twitter:image", content: image.url },
      { name: "twitter:image:alt", content: image.alt },
    );
  }

  return {
    meta,
    links: canonical ? [{ rel: "canonical", href: url }] : [],
  };
}

