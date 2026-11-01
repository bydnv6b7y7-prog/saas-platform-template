import {
  auth,
  getUserBillingStatus,
  stripeBilling,
} from "@northwind/auth";
import { adminAccess } from "@northwind/auth/admin";
import {
  type UserBillingStatus,
  withAdminAccess,
} from "@northwind/billing";
import { Hono } from "hono";

import { captureRequestError } from "../logging";

type BillingDependencies = {
  getCatalog: typeof stripeBilling.getCatalog;
  getSession: (
    headers: Headers,
  ) => Promise<{ user: { id: string; role?: string | null } } | null>;
  getStatus: (userId: string) => Promise<UserBillingStatus>;
  isAdmin: typeof adminAccess.allows;
};

const defaultDependencies: BillingDependencies = {
  getCatalog: () => stripeBilling.getCatalog(),
  getSession: (headers) => auth.api.getSession({ headers }),
  getStatus: getUserBillingStatus,
  isAdmin: (user) => adminAccess.allows(user),
};

export function createBillingApp(overrides: Partial<BillingDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  return new Hono()
    .get("/api/billing/catalog", async (c) => {
      try {
        const catalog = await dependencies.getCatalog();
        c.header(
          "Cache-Control",
          catalog.configured
            ? "public, max-age=300, stale-while-revalidate=600"
            : "public, max-age=60",
        );
        return c.json(catalog);
      } catch (error) {
        captureRequestError(error, { operation: "billing_catalog" });
        c.header("Cache-Control", "no-store");
        return c.json({ error: "Billing catalog is temporarily unavailable" }, 503);
      }
    })
    .get("/api/billing/status", async (c) => {
      c.header("Cache-Control", "private, no-store");
      try {
        const session = await dependencies.getSession(c.req.raw.headers);
        if (!session) return c.json({ error: "Unauthorized" }, 401);
        const status = await dependencies.getStatus(session.user.id);
        return c.json(
          dependencies.isAdmin(session.user) ? withAdminAccess(status) : status,
        );
      } catch (error) {
        captureRequestError(error, { operation: "billing_status" });
        return c.json({ error: "Subscription status is temporarily unavailable" }, 503);
      }
    });
}

export const billingApp = createBillingApp();
