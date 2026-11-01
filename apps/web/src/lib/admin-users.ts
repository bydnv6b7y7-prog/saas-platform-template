import { queryOptions } from "@tanstack/react-query";
import {
  adminCreateUserSchema,
  adminUpdateUserSchema,
  type AdminUserDetails,
  normalizeAdminUserEmail,
} from "@northwind/auth/admin-user-contract";

import { authClient } from "./auth-client";

const PAGE_SIZE = 20;
const LOAD_ERROR = "Users could not be loaded";

export type AdminUser = NonNullable<
  Awaited<ReturnType<typeof authClient.admin.listUsers>>["data"]
>["users"][number];

export type AdminUserFormValues = Omit<AdminUserDetails, "role"> & {
  role: string;
};

export function adminUsersQueryKey(adminUserId: string) {
  return ["better-auth", "admin", "users", adminUserId] as const;
}

export function getAdminUserChanges(
  user: AdminUserFormValues,
  draft: AdminUserFormValues,
) {
  const normalized = {
    ...draft,
    name: draft.name.trim(),
    email: normalizeAdminUserEmail(draft.email),
  };
  const changes = Object.fromEntries(
    (Object.keys(normalized) as (keyof AdminUserFormValues)[])
      .filter((key) => normalized[key] !== user[key])
      .map((key) => [key, normalized[key]]),
  );
  // A new email has its own verification decision, even if the checkbox matches the old email.
  if (normalized.email !== user.email)
    changes.emailVerified = normalized.emailVerified;
  return changes;
}

export function updateAdminUserEmail(
  values: AdminUserFormValues,
  email: string,
): AdminUserFormValues {
  return {
    ...values,
    email,
    emailVerified:
      normalizeAdminUserEmail(email) === normalizeAdminUserEmail(values.email)
        ? values.emailVerified
        : false,
  };
}

export async function createAdminUser(
  input: AdminUserFormValues & { password: string },
) {
  const parsed = adminCreateUserSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0]!.message);
  const { emailVerified, ...fields } = parsed.data;
  const response = await authClient.admin.createUser({
    ...fields,
    data: { emailVerified },
  });
  if (response.error)
    throw new Error(response.error.message || "User could not be created.");
  if (!response.data?.user) throw new Error("User could not be created.");
  return response.data.user;
}

export async function updateAdminUser({
  userId,
  data,
}: {
  userId: string;
  data: Record<string, unknown>;
}) {
  const parsed = adminUpdateUserSchema.safeParse(data);
  if (!parsed.success) throw new Error(parsed.error.issues[0]!.message);
  const response = await authClient.admin.updateUser({
    userId,
    data: parsed.data,
  });
  if (response.error)
    throw new Error(response.error.message || "User could not be updated.");
  if (!response.data) throw new Error("User could not be updated.");
  return response.data;
}

export async function deleteAdminUser(userId: string) {
  const response = await authClient.admin.removeUser({ userId });
  if (response.error)
    throw new Error(response.error.message || "User could not be deleted.");
  if (!response.data?.success) throw new Error("User could not be deleted.");
}

export type AdminUserSearchField = "email" | "name";

export type AdminUserSearch = {
  field: AdminUserSearchField;
  value: string;
};

export function createAdminUserSearch(
  field: AdminUserSearchField,
  value: string,
): AdminUserSearch | null {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized ? { field, value: normalized } : null;
}

export function adminUsersQueryOptions({
  adminUserId,
  page,
  search,
}: {
  adminUserId: string;
  page: number;
  search: AdminUserSearch | null;
}) {
  const pageIndex = Math.max(0, Math.trunc(page));
  const normalizedSearch = search
    ? createAdminUserSearch(search.field, search.value)
    : null;

  return queryOptions({
    queryKey: [
      ...adminUsersQueryKey(adminUserId),
      { page: pageIndex, search: normalizedSearch },
    ],
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await authClient.admin.listUsers(
        {
          query: {
            limit: PAGE_SIZE,
            offset: pageIndex * PAGE_SIZE,
            sortBy: "createdAt",
            sortDirection: "desc",
            ...(normalizedSearch
              ? {
                  searchField: normalizedSearch.field,
                  searchOperator: "contains" as const,
                  searchValue: normalizedSearch.value,
                }
              : {}),
          },
        },
        { signal },
      );
      if (response.error) throw new Error(response.error.message || LOAD_ERROR);
      if (!response.data) throw new Error(LOAD_ERROR);

      const pageCount = Math.max(1, Math.ceil(response.data.total / PAGE_SIZE));
      return {
        ...response.data,
        page: pageIndex,
        pageCount,
        hasPreviousPage: pageIndex > 0,
        hasNextPage: pageIndex + 1 < pageCount,
      };
    },
  });
}
