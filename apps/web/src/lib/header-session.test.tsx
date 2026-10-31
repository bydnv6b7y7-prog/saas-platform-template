import { describe, expect, test } from "bun:test";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";

import Header from "@/components/header";
import type { AppUser, SessionStatus } from "@/components/app-shell";

async function renderHeader(user: AppUser | null, sessionStatus?: SessionStatus) {
  const route = createRootRoute({ component: () => <Header user={user} isAdmin={false} sessionStatus={sessionStatus} /> });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const retry = () => {};

describe("header session state", () => {
  test("does not show Sign in while the initial Cookie check is pending", async () => {
    const html = await renderHeader(null, { isPending: true, error: null, retry });
    expect(html).toContain("Checking sign-in status");
    expect(html).not.toContain(">Sign in<");
  });

  test("renders the verified SSR account before the browser check completes", async () => {
    const html = await renderHeader({ id: "reader", name: "Reader", email: "reader@example.invalid" }, { isPending: true, error: null, retry });
    expect(html).toContain("Loading account menu");
    expect(html).not.toContain(">Sign in<");
    expect(html).not.toContain("Checking sign-in status");
  });

  test("offers a retry after a session read failure", async () => {
    const html = await renderHeader(null, { isPending: false, error: new Error("network"), retry });
    expect(html).toContain("Retry account");
    expect(html).not.toContain(">Sign in<");
  });

  test("shows Sign in after a successful anonymous response", async () => {
    const html = await renderHeader(null, { isPending: false, error: null, retry });
    expect(html).toContain(">Sign in<");
    expect(html).not.toContain("Checking sign-in status");
  });
});
