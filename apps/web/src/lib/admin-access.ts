import { queryOptions } from "@tanstack/react-query";

import { authClient } from "./auth-client";

const ACCESS_ERROR = "Administrator access could not be verified";

export function adminAccessQueryOptions(userId: string) {
  return queryOptions({
    queryKey: ["better-auth", "admin", "access", userId],
    retry: false,
    staleTime: 30_000,
    queryFn: async (): Promise<boolean> => {
      const response = await authClient.admin.hasPermission({
        permissions: { user: ["list"] },
      });
      if (response.error) throw new Error(response.error.message || ACCESS_ERROR);
      if (!response.data) throw new Error(ACCESS_ERROR);
      return response.data.success;
    },
  });
}
