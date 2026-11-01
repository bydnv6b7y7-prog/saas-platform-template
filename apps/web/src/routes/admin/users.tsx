import { Button } from "@northwind/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@northwind/ui/components/card";
import { Input } from "@northwind/ui/components/input";
import { Skeleton } from "@northwind/ui/components/skeleton";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { AdminNav } from "@/components/admin/admin-nav";
import { AdminUserDialog, type AdminUserAction } from "@/components/admin/admin-user-dialog";
import {
  type AdminUserSearch,
  type AdminUserSearchField,
  adminUsersQueryOptions,
  adminUsersQueryKey,
  createAdminUserSearch,
} from "@/lib/admin-users";
import { formatUtcDate } from "@/lib/format";

export const Route = createFileRoute("/admin/users")({
  component: AdminUsersPage,
});

function AdminUsersPage() {
  const { user } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const router = useRouter();
  const createButton = useRef<HTMLButtonElement>(null);
  const actionTrigger = useRef<HTMLElement | null>(null);
  const [action, setAction] = useState<AdminUserAction | null>(null);
  const [draftSearch, setDraftSearch] = useState("");
  const [draftSearchField, setDraftSearchField] =
    useState<AdminUserSearchField>("email");
  const [search, setSearch] = useState<AdminUserSearch | null>(null);
  const [page, setPage] = useState(0);
  const usersQuery = useQuery(
    adminUsersQueryOptions({
      adminUserId: user.id,
      page,
      search,
    }),
  );
  const data = usersQuery.data;

  useEffect(() => {
    if (data && !usersQuery.isFetching && page >= data.pageCount) setPage(data.pageCount - 1);
  }, [data, page, usersQuery.isFetching]);

  const saved = async () => {
    toast.success(action?.type === "create" ? "User created." : action?.type === "delete" ? "User deleted." : "User updated.");
    await queryClient.invalidateQueries({ queryKey: adminUsersQueryKey(user.id) });
    if (action?.type === "edit" && action.user.id === user.id) {
      // Refresh the shared account header after changing the signed-in admin.
      void router.invalidate();
    }
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSearch(createAdminUserSearch(draftSearchField, draftSearch));
    setPage(0);
  };

  return (
    <div className="page-shell max-w-5xl">
      <AdminNav />

      <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
        <p className="text-sm font-medium text-brand">Administration</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">
          Users
        </h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">
          Manage user accounts, roles, and email verification.
        </p>
        </div>
        <Button ref={createButton} type="button" data-icon="inline-start" onClick={(event) => {
          actionTrigger.current = event.currentTarget;
          setAction({ type: "create" });
        }}>
          <Plus aria-hidden="true" /> Create user
        </Button>
      </header>

      <form
        className="mb-5 grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto]"
        onSubmit={submitSearch}
      >
        <label className="sr-only" htmlFor="admin-user-search-field">
          Search field
        </label>
        <select
          id="admin-user-search-field"
          value={draftSearchField}
          onChange={(event) =>
            setDraftSearchField(event.target.value as AdminUserSearchField)
          }
          className="h-11 rounded-xl border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
        >
          <option value="email">Email</option>
          <option value="name">Name</option>
        </select>
        <label className="sr-only" htmlFor="admin-user-search">
          Search users
        </label>
        <Input
          id="admin-user-search"
          type="search"
          maxLength={128}
          value={draftSearch}
          onChange={(event) => setDraftSearch(event.target.value)}
          placeholder={draftSearchField === "email" ? "Search by email" : "Search by name"}
        />
        <Button type="submit" variant="outline" data-icon="inline-start">
          <Search aria-hidden="true" /> Search
        </Button>
      </form>

      {usersQuery.isLoading ? (
        <div className="grid gap-3">
          <Skeleton className="h-16 rounded-2xl" />
          <Skeleton className="h-80 rounded-2xl" />
        </div>
      ) : usersQuery.isError ? (
        <Card className="items-center p-8 text-center">
          <p className="font-medium">Users could not be loaded.</p>
          <p className="text-sm text-muted-foreground">{usersQuery.error.message}</p>
          <Button variant="outline" onClick={() => usersQuery.refetch()} data-icon="inline-start">
            <RefreshCw aria-hidden="true" /> Retry
          </Button>
        </Card>
      ) : data ? (
        <Card className="gap-0 overflow-hidden py-0">
          <CardHeader className="flex-row items-center justify-between border-b p-5">
            <CardTitle className="text-base">
              {search ? `Results for “${search.value}”` : "All accounts"}
            </CardTitle>
            <span className="text-sm tabular-nums text-muted-foreground">
              {data.total.toLocaleString("en-US")} total
            </span>
          </CardHeader>
          <CardContent className="p-0">
            {data.users.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                  <thead className="bg-muted/40 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-5 py-3 font-medium" scope="col">Account</th>
                      <th className="px-5 py-3 font-medium" scope="col">Role</th>
                      <th className="px-5 py-3 font-medium" scope="col">Status</th>
                      <th className="px-5 py-3 font-medium" scope="col">Joined</th>
                      <th className="px-5 py-3 font-medium" scope="col">User ID</th>
                      <th className="px-5 py-3 text-right font-medium" scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.users.map((account) => (
                      <tr key={account.id} className="border-t border-border/70 first:border-t-0">
                        <td className="px-5 py-4">
                          <p className="font-medium text-foreground">{account.name || "Unnamed user"}{account.id === user.id ? <span className="ml-2 text-xs font-normal text-muted-foreground">You</span> : null}</p>
                          <p className="mt-0.5 text-muted-foreground">{account.email}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{account.emailVerified ? "Email verified" : "Email unverified"}</p>
                        </td>
                        <td className="px-5 py-4 capitalize text-muted-foreground">
                          {account.role || "user"}
                        </td>
                        <td className="px-5 py-4">
                          <span
                            className={
                              account.banned
                                ? "rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive"
                                : "rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400"
                            }
                          >
                            {account.banned ? "Banned" : "Active"}
                          </span>
                        </td>
                        <td className="px-5 py-4 whitespace-nowrap text-muted-foreground">
                          {formatUtcDate(account.createdAt)}
                        </td>
                        <td className="max-w-40 truncate px-5 py-4 font-mono text-xs text-muted-foreground" title={account.id}>
                          {account.id}
                        </td>
                        <td className="px-5 py-4">
                          <div className="flex justify-end gap-1">
                            <Button type="button" variant="ghost" size="icon-sm" aria-label={`Edit ${account.email}`} onClick={(event) => {
                              actionTrigger.current = event.currentTarget;
                              setAction({ type: "edit", user: account });
                            }}><Pencil aria-hidden="true" /></Button>
                            <Button type="button" variant="ghost" size="icon-sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={account.id === user.id} title={account.id === user.id ? "You cannot delete your own account." : "Delete user"} aria-label={`Delete ${account.email}`} onClick={(event) => {
                              actionTrigger.current = event.currentTarget;
                              setAction({ type: "delete", user: account });
                            }}><Trash2 aria-hidden="true" /></Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-10 text-center">
                <p className="font-medium">No users found.</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {search ? "Try a different search." : "Accounts will appear after registration."}
                </p>
              </div>
            )}

            <div className="flex items-center justify-between border-t px-5 py-4">
              <p className="text-sm tabular-nums text-muted-foreground" aria-live="polite">
                Page {Math.min(data.page + 1, data.pageCount)} of {data.pageCount}
                {usersQuery.isFetching ? " · Updating" : ""}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="Previous page"
                  disabled={!data.hasPreviousPage || usersQuery.isFetching}
                  onClick={() => setPage((value) => Math.max(0, value - 1))}
                >
                  <ChevronLeft aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="Next page"
                  disabled={!data.hasNextPage || usersQuery.isFetching}
                  onClick={() => setPage((value) => value + 1)}
                >
                  <ChevronRight aria-hidden="true" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}
      {action ? <AdminUserDialog
        action={action}
        adminUserId={user.id}
        onSaved={saved}
        onClose={() => setAction(null)}
        restoreFocus={() => actionTrigger.current?.isConnected ? actionTrigger.current : createButton.current}
      /> : null}
    </div>
  );
}
