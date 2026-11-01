import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";
import { adminAccessQueryOptions } from "@/lib/admin-access";
import { authClient } from "@/lib/auth-client";
import { productHome } from "@/product";

export const Route = createFileRoute("/admin")({
  ssr: false,
  head: () => ({
    meta: [
      { name: "robots", content: "noindex, nofollow, noarchive" },
      { name: "googlebot", content: "noindex, nofollow, noarchive" },
    ],
  }),
  beforeLoad: async ({ context, location }) => {
    const session = await authClient.getSession();
    if (!session.data) {
      throw redirect({
        to: "/login",
        search: { redirect: location.pathname },
      });
    }
    const user = session.data.user;
    const hasAccess = await context.queryClient.fetchQuery(
      adminAccessQueryOptions(user.id),
    );
    if (!hasAccess) {
      throw redirect({ to: productHome.to });
    }
    return { user };
  },
  component: AdminLayout,
});

function AdminLayout() {
  const { user } = Route.useRouteContext();
  return (
    <AppShell user={{ id: user.id, name: user.name ?? "Administrator", email: user.email }}>
      <Outlet />
    </AppShell>
  );
}
