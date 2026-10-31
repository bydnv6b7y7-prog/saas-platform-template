/**
 * Web product seam. Platform components and routes import only `@/product` and `@/product/assistant`;
 * a new product replaces src/product and every `(product)` route group and keeps these exports.
 */
import type { AssistantPageContext } from "@northwind/product/assistant-contracts";
import type { LinkProps } from "@tanstack/react-router";
import { House, type LucideIcon } from "lucide-react";
import type { ComponentType, LazyExoticComponent } from "react";

import type { SitemapEntry } from "@/lib/sitemap";

export type ProductLink = { to: NonNullable<LinkProps["to"]>; label: string; icon: LucideIcon };

/** Brand link, post-login default and "back" destination. */
export const productHome = { to: "/", label: "Home" } as const;

/** Header links shown before the platform's Pricing link. */
export const productNavLinks: readonly ProductLink[] = [{ to: "/", label: "Home", icon: House }];

/** Extra signed-in account menu entries. */
export const productAccountLinks: readonly ProductLink[] = [];

/** Admin landing page and product Admin tabs (placed before the platform tabs). */
export const productAdminHome = "/admin/users" as const;
export const productAdminLinks: readonly ProductLink[] = [];

/** Footer links next to Pricing / Privacy / Terms. */
export const productFooterLinks: readonly Omit<ProductLink, "icon">[] = [];

/** Product pages that render without the app shell (header, sidecar, footer). */
export function isProductStandalonePath(_pathname: string): boolean {
  return false;
}

/** Extra Admin → Settings sections, each loaded when opened (e.g. a RuntimeSettingsPanel for a product settings scope). */
export const productAdminSettings: { title: string; detail: string; Component: LazyExoticComponent<ComponentType> }[] = [];

/** Sign-in page pitch above the form. */
export const productPitch = {
  eyebrow: "Welcome",
  summary: "Sign in to use the assistant and keep your conversation history.",
};

/** Shown after an assistant failure; must stay true for anything the assistant can touch. */
export const assistantFailureReassurance = "Nothing was changed.";

export const productSeo = {
  title: "Your product",
  description: "A product built on the platform template: accounts, subscriptions, storage, and an AI assistant.",
};

export const productPricing = {
  title: "Start free. Upgrade when you need more.",
  headline: "Start free. Pro raises the daily AI allowance.",
  description: "Use the product and the AI assistant for free, or upgrade for higher AI limits.",
  freeSummary: "Everything you need to get started.",
  freeFeatures: ["AI assistant with a daily allowance", "Private conversation history"],
  freeFallback: "The free plan remains available.",
  ctaLabel: "Get started",
};

/** Indexable product pages; platform pages (pricing, legal) are added by the platform. */
export async function productSitemapEntries(): Promise<SitemapEntry[]> {
  return [{ path: "/" }];
}

export function buildAssistantPageContext(pathname: string, _search: Record<string, unknown>): AssistantPageContext {
  return { kind: "page", path: pathname.slice(0, 300) };
}

export function assistantPageContextLabel(context: AssistantPageContext): string {
  return context.path === "/" ? "this page" : context.path;
}

export function assistantSuggestions(_context: AssistantPageContext): { title: string; message: string }[] {
  return [{ title: "What can you do?", message: "What can you help me with here?" }];
}
