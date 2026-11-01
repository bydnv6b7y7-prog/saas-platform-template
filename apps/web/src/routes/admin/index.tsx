import { createFileRoute, redirect } from "@tanstack/react-router";

import { productAdminHome } from "@/product";

export const Route = createFileRoute("/admin/")({
  beforeLoad: () => {
    throw redirect({ to: productAdminHome });
  },
});
