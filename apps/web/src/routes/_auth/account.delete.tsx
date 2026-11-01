import { Button } from "@northwind/ui/components/button";
import { Card } from "@northwind/ui/components/card";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Check, Trash2, X } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { DeleteAccountDialog } from "@/components/delete-account-dialog";
import { resetAnalyticsIdentity } from "@/lib/analytics";

export const Route = createFileRoute("/_auth/account/delete")({
  component: DeleteAccountPage,
});

const DELETED = [
  "Profile and account details",
  "Sign-in credentials and social account links",
  "Active sessions on every device",
  "Assistant conversation history",
  "Saved validations and private semantic queries",
  "Share links",
  "Usage counters and unexpired email codes",
];

const RETAINED = [
  "Billing and transaction records required for finance and compliance (anonymized)",
  "Apple purchase ownership records (anonymized tombstones)",
  "Operational audit records",
];

function DeleteAccountPage() {
  const { user } = Route.useRouteContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleDeleted = () => {
    toast.success("Your account has been deleted.");
    resetAnalyticsIdentity();
    queryClient.clear();
    void navigate({ to: "/login" });
  };

  return (
    <div className="page-shell max-w-4xl">
      <header className="mb-7">
        <p className="text-sm font-medium text-brand">Account</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">
          Delete account
        </h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">
          Permanently delete your Northwind account and personal data. Deletion is
          immediate and cannot be undone.
        </p>
      </header>

      <div className="grid gap-5">
        <Card className="p-6 sm:p-8">
          <h2 className="text-lg font-semibold tracking-tight">What is deleted</h2>
          <ul className="mt-4 space-y-2.5">
            {DELETED.map((item) => (
              <li key={item} className="flex items-start gap-2.5 text-sm leading-6">
                <X className="mt-1 size-4 shrink-0 text-destructive" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-6 sm:p-8">
          <h2 className="text-lg font-semibold tracking-tight">What is retained</h2>
          <ul className="mt-4 space-y-2.5">
            {RETAINED.map((item) => (
              <li key={item} className="flex items-start gap-2.5 text-sm leading-6">
                <Check className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            Records we must keep for legal, tax, and fraud-prevention reasons are
            retained in anonymized form and are no longer linked to you.
          </p>
        </Card>

        <Card className="p-6 sm:p-8">
          <h2 className="text-lg font-semibold tracking-tight">Subscriptions</h2>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            If you pay with a card, your subscription is automatically cancelled
            at the end of the current billing period; it will not renew, and no
            further action is needed.
          </p>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            If you subscribed on iPhone or iPad, Apple manages that subscription
            — cancel it in{" "}
            <span className="font-medium text-foreground">
              App Store → Subscriptions
            </span>
            . We cannot cancel Apple subscriptions for you.
          </p>
        </Card>

        <Card className="flex flex-wrap items-center justify-between gap-4 p-6 sm:p-8">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Ready?</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              You will be asked to type your account email to confirm.
            </p>
          </div>
          <Button
            ref={buttonRef}
            variant="destructive"
            onClick={() => setConfirming(true)}
          >
            <Trash2 aria-hidden="true" />
            Delete account…
          </Button>
        </Card>
      </div>

      {confirming ? (
        <DeleteAccountDialog
          email={user.email}
          onSuccess={handleDeleted}
          onClose={() => setConfirming(false)}
          restoreFocus={() => buttonRef.current}
        />
      ) : null}
    </div>
  );
}
