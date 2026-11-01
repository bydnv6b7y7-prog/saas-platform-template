import { env } from "@northwind/env/web";
import { productHome } from "@/product";

export function getAbsoluteAppURL(path: string = productHome.to): string {
  const origin = typeof window === "undefined" ? env.VITE_WEB_URL : window.location.origin;
  return new URL(path, `${origin.replace(/\/$/, "")}/`).toString();
}

/** Apple 图标 URL 压缩：mzstatic 尺寸后缀改写到目标边长，减少下载体积。 */
export function compactIconUrl(src: string, size: 96 | 160 = 96): string {
  if (!src.includes("mzstatic.com")) return src;
  return src.replace(/\/\d+x\d+bb(?=\.[a-z0-9]+(?:\?|$))/i, `/${size}x${size}bb`);
}
