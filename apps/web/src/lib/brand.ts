import { env } from "@northwind/env/web";

export const brandName = env.VITE_BRAND_NAME;
/** What the assistant is called throughout the UI. */
export const assistantName = `${brandName} AI`;
