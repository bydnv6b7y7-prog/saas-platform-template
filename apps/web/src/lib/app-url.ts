import { env } from "@northwind/env/web";
import { productHome } from "@/product";

export function getAbsoluteAppURL(path: string = productHome.to): string {
  const origin = typeof window === "undefined" ? env.VITE_WEB_URL : window.location.origin;
  return new URL(path, `${origin.replace(/\/$/, "")}/`).toString();
}
