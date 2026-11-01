import {
  ADMIN_USER_EMAIL_MAX_LENGTH,
  ADMIN_USER_NAME_MAX_LENGTH,
  ADMIN_USER_PASSWORD_MAX_LENGTH,
  ADMIN_USER_PASSWORD_MIN_LENGTH,
  adminUserRoleSchema,
} from "@northwind/auth/admin-user-contract";
import { Button } from "@northwind/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@northwind/ui/components/dialog";
import { Input } from "@northwind/ui/components/input";
import { Label } from "@northwind/ui/components/label";
import { useMutation } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";

import {
  type AdminUser,
  type AdminUserFormValues,
  createAdminUser,
  deleteAdminUser,
  getAdminUserChanges,
  updateAdminUser,
  updateAdminUserEmail,
} from "@/lib/admin-users";

export type AdminUserAction =
  | { type: "create" }
  | { type: "edit" | "delete"; user: AdminUser };

export function AdminUserDialog({
  action,
  adminUserId,
  onSaved,
  onClose,
  restoreFocus,
}: {
  action: AdminUserAction;
  adminUserId: string;
  onSaved: () => Promise<void>;
  onClose: () => void;
  restoreFocus: () => HTMLElement | null;
}) {
  const account = action.type === "create" ? null : action.user;
  const initial: AdminUserFormValues = {
    name: account?.name ?? "",
    email: account?.email ?? "",
    role: account?.role || "user",
    emailVerified: account?.emailVerified ?? false,
  };
  const [values, setValues] = useState(initial);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [open, setOpen] = useState(true);
  const submitting = useRef(false);
  const isDelete = action.type === "delete";
  const isCreate = action.type === "create";
  const changes = getAdminUserChanges(initial, values);
  const title = isDelete
    ? "Delete user"
    : isCreate
      ? "Create user"
      : "Edit user";
  const mutation = useMutation({
    retry: false,
    gcTime: 0,
    mutationFn: async () => {
      if (action.type === "delete") return deleteAdminUser(action.user.id);
      if (action.type === "edit")
        return updateAdminUser({ userId: action.user.id, data: changes });
      return createAdminUser({
        ...values,
        password,
      });
    },
    onSuccess: async () => {
      setPassword("");
      await onSaved();
      setOpen(false);
    },
    onSettled: () => {
      submitting.current = false;
    },
  });
  const canSubmit =
    !mutation.isPending &&
    (isDelete
      ? confirmation === account?.email
      : isCreate || Object.keys(changes).length > 0);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || submitting.current) return;
    submitting.current = true;
    mutation.mutate();
  };

  return (
    <Dialog
      open={open}
      disablePointerDismissal
      onOpenChange={(nextOpen) => {
        if (!mutation.isPending) setOpen(nextOpen);
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent finalFocus={restoreFocus}>
        <DialogTitle className="text-xl font-semibold tracking-tight">
          {title}
        </DialogTitle>
        <DialogDescription className="mt-2 text-sm leading-6 text-muted-foreground">
          {isDelete ? (
            <>
              Permanently delete{" "}
              <span className="break-all font-medium text-foreground">
                {account?.email}
              </span>{" "}
              and its sign-in accounts and sessions. This cannot be undone.
              Deleting an account does not cancel subscriptions; billing records
              are retained.
            </>
          ) : isCreate ? (
            "Add an account with an initial password."
          ) : (
            "Update account details and administrator access."
          )}
        </DialogDescription>

        <form
          className="mt-5 space-y-4"
          onSubmit={submit}
          aria-busy={mutation.isPending}
        >
          <fieldset disabled={mutation.isPending} className="space-y-4">
            {isDelete ? (
              <div className="space-y-2">
                <Label htmlFor="admin-user-confirm">
                  Type the user's email to confirm
                </Label>
                <Input
                  id="admin-user-confirm"
                  type="email"
                  autoComplete="off"
                  required
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="admin-user-name">Name</Label>
                  <Input
                    id="admin-user-name"
                    name="name"
                    autoComplete="off"
                    required
                    maxLength={ADMIN_USER_NAME_MAX_LENGTH}
                    value={values.name}
                    onChange={(event) =>
                      setValues({ ...values, name: event.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="admin-user-email">Email</Label>
                  <Input
                    id="admin-user-email"
                    name="email"
                    type="email"
                    autoComplete="off"
                    required
                    maxLength={ADMIN_USER_EMAIL_MAX_LENGTH}
                    value={values.email}
                    onChange={(event) =>
                      setValues(
                        updateAdminUserEmail(values, event.target.value),
                      )
                    }
                  />
                </div>
                {isCreate ? (
                  <div className="space-y-2">
                    <Label htmlFor="admin-user-password">
                      Initial password
                    </Label>
                    <Input
                      id="admin-user-password"
                      name="password"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={ADMIN_USER_PASSWORD_MIN_LENGTH}
                      maxLength={ADMIN_USER_PASSWORD_MAX_LENGTH}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      aria-describedby="admin-user-password-help"
                    />
                    <p
                      id="admin-user-password-help"
                      className="text-xs text-muted-foreground"
                    >
                      Use 8–128 characters. Share the password with the user
                      securely.
                    </p>
                  </div>
                ) : null}
                <div className="space-y-2">
                  <Label htmlFor="admin-user-role">Role</Label>
                  <select
                    id="admin-user-role"
                    name="role"
                    className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
                    value={values.role}
                    disabled={account?.id === adminUserId}
                    onChange={(event) =>
                      setValues({ ...values, role: event.target.value })
                    }
                    aria-describedby="admin-user-role-help"
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                    {!adminUserRoleSchema.safeParse(initial.role).success ? (
                      <option value={initial.role}>{initial.role}</option>
                    ) : null}
                  </select>
                  <p
                    id="admin-user-role-help"
                    className="text-xs text-muted-foreground"
                  >
                    {account?.id === adminUserId
                      ? "Your own role cannot be changed here."
                      : "Admins can manage users and settings and receive Pro access."}
                  </p>
                </div>
                <div>
                  <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      name="emailVerified"
                      className="size-4 accent-primary"
                      checked={values.emailVerified}
                      onChange={(event) =>
                        setValues({
                          ...values,
                          emailVerified: event.target.checked,
                        })
                      }
                      aria-describedby="admin-user-verified-help"
                    />
                    Email verified
                  </label>
                  <p
                    id="admin-user-verified-help"
                    className="mt-2 text-xs leading-5 text-muted-foreground"
                  >
                    Only mark this if email ownership is confirmed. Otherwise,
                    the user must verify their email before signing in.
                  </p>
                </div>
              </>
            )}
          </fieldset>

          {mutation.isError ? (
            <p
              role="alert"
              className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive"
            >
              {mutation.error.message}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <DialogClose
              render={<Button variant="outline" />}
              disabled={mutation.isPending}
            >
              Cancel
            </DialogClose>
            <Button
              type="submit"
              variant={isDelete ? "destructive" : "default"}
              disabled={!canSubmit}
            >
              {mutation.isPending ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : null}
              {mutation.isPending
                ? isDelete
                  ? "Deleting…"
                  : "Saving…"
                : isDelete
                  ? "Delete user"
                  : isCreate
                    ? "Create user"
                    : "Save changes"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
