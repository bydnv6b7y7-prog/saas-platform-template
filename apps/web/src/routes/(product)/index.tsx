import { env } from "@northwind/env/web";
import { buttonVariants } from "@northwind/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";

import { AssistantLaunchButton } from "@/components/assistant-launch-button";
import { authClient } from "@/lib/auth-client";
import { createSeoHead } from "@/lib/seo";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/(product)/")({
  head: () => createSeoHead({ path: "/" }),
  component: HomePage,
});

function HomePage() {
  const trpc = useTRPC();
  const hello = useQuery(trpc.example.hello.queryOptions({}));
  const session = authClient.useSession();

  return (
    <div className="page-shell max-w-3xl py-16">
      <h1 className="text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">{env.VITE_BRAND_NAME}</h1>
      <p className="mt-4 text-base leading-7 text-muted-foreground">
        Replace this page with your product. Accounts, subscriptions, file storage, analytics, the admin
        console, and the AI assistant (bottom-right) already work.
      </p>
      <p className="mt-4 text-sm text-muted-foreground" aria-live="polite">
        API: {hello.isPending ? "connecting…" : hello.isError ? "unavailable" : hello.data.message}
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link to="/pricing" className={buttonVariants()}>See pricing</Link>
        {session.data ? (
          <>
            <AssistantLaunchButton label="Ask the assistant" size="default" />
            <Link to="/account/billing" className={buttonVariants({ variant: "outline" })}>Your account</Link>
          </>
        ) : session.isPending ? null : (
          <Link to="/login" className={buttonVariants({ variant: "outline" })}>Sign in</Link>
        )}
      </div>
    </div>
  );
}
