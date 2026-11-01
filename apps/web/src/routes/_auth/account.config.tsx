import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth/account/config")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/config" });
  },
});
