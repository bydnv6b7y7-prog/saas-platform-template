import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";
import { authClient } from "@/lib/auth-client";

/**
 * 登录后回跳原目标（保留 search 参数，如 /search?q=...）。
 * TanStack Router 已知坑：重定向链中 location.search 可能是解析后的**对象**
 * 而非字符串（对象模板拼接会抛 "Cannot convert object to primitive value"），
 * 因此从 location.href 兜底提取 pathname+search。
 */
function returnTo(location: { pathname: string; search: unknown; href: string }): string {
  if (typeof location.search === "string") {
    return `${location.pathname}${location.search}`;
  }
  try {
    const url = new URL(location.href);
    return `${url.pathname}${url.search}`;
  } catch {
    return location.pathname; // href 非绝对地址时退化为纯 pathname（仅影响回跳）
  }
}

export const Route = createFileRoute("/_auth")({
  ssr: false,
  head: () => ({
    meta: [
      { name: "robots", content: "noindex, nofollow, noarchive" },
      { name: "googlebot", content: "noindex, nofollow, noarchive" },
    ],
  }),
  component: AuthLayout,
  beforeLoad: async ({ location }) => {
    const session = await authClient.getSession();
    if (!session.data) {
      throw redirect({
        to: "/login",
        search: { redirect: returnTo(location) },
      });
    }
    return { user: session.data.user };
  },
});

function AuthLayout() {
  const { user } = Route.useRouteContext();

  return (
    <AppShell
      user={{
        id: user.id,
        name: user.name ?? "Account",
        email: user.email,
      }}
    >
      <Outlet />
    </AppShell>
  );
}
