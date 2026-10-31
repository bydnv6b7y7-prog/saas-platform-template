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

import { deleteAccount } from "@/lib/account";

export function DeleteAccountDialog({
  email,
  onSuccess,
  onClose,
  restoreFocus,
}: {
  email: string;
  onSuccess: () => void;
  onClose: () => void;
  restoreFocus: () => HTMLElement | null;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [open, setOpen] = useState(true);
  const submitting = useRef(false);
  const mutation = useMutation({
    retry: false,
    gcTime: 0,
    mutationFn: () => deleteAccount(confirmation.trim().toLowerCase()),
    onSuccess: () => {
      onSuccess();
      setOpen(false);
    },
    onSettled: () => {
      submitting.current = false;
    },
  });
  const canSubmit =
    !mutation.isPending &&
    confirmation.trim().toLowerCase() === email.toLowerCase();
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
          Delete account
        </DialogTitle>
        <DialogDescription className="mt-2 text-sm leading-6 text-muted-foreground">
          Permanently delete{" "}
          <span className="break-all font-medium text-foreground">{email}</span>{" "}
          along with your profile, credentials, sessions, and assistant
          conversation history. This cannot be undone.
        </DialogDescription>

        <form
          className="mt-5 space-y-4"
          onSubmit={submit}
          aria-busy={mutation.isPending}
        >
          <fieldset disabled={mutation.isPending} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="delete-account-confirm">
                Type your account email to confirm
              </Label>
              <Input
                id="delete-account-confirm"
                type="email"
                autoComplete="off"
                required
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </div>
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
            <Button type="submit" variant="destructive" disabled={!canSubmit}>
              {mutation.isPending ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : null}
              {mutation.isPending ? "Deleting…" : "Delete my account"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
