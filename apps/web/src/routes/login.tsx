import { env } from "@northwind/env/web";
import { Button } from "@northwind/ui/components/button";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";

import { BrandMark } from "@/components/brand-mark";
import { ModeToggle } from "@/components/mode-toggle";
import SignInForm from "@/components/sign-in-form";
import SignUpForm from "@/components/sign-up-form";
import { getAbsoluteAppURL } from "@/lib/app-url";
import {
  authClient,
  getEnabledSocialProviders,
  socialProviderIds,
  type SocialProviderId,
} from "@/lib/auth-client";
import { createSeoHead } from "@/lib/seo";
import { safeRedirectTarget } from "@/lib/email-verification";
import {
  getOAuthErrorURL,
  socialProviderLabels,
} from "@/lib/social-auth";
import { productFooterLinks, productHome, productPitch } from "@/product";

export const Route = createFileRoute("/login")({
  ssr: false,
  component: RouteComponent,
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    redirect?: string;
    error?: string;
    provider?: SocialProviderId;
    link?: boolean;
    signup?: boolean;
    verification?: boolean;
  } => {
    const target = safeRedirectTarget(search.redirect);
    const error = typeof search.error === "string" ? search.error.trim().slice(0, 100) : "";
    const provider = socialProviderIds.find((value) => value === search.provider);
    return {
      ...(target ? { redirect: target } : {}),
      ...(error ? { error } : {}),
      ...(provider ? { provider } : {}),
      ...(search.link === "1" ? { link: true } : {}),
      ...(search.signup === "1" ? { signup: true } : {}),
      ...(search.verification === "1" ? { verification: true } : {}),
    };
  },
  beforeLoad: async ({ search }) => {
    const session = await authClient.getSession();
    if (session.data && !(search.link && search.provider && (search.error || search.verification))) {
      throw redirect({ href: search.redirect ?? productHome.to });
    }
    return { session };
  },
  loader: () => getEnabledSocialProviders(),
  head: () => {
    const seo = createSeoHead({
      title: "Sign In",
      description: "Sign in to run searches, save validations, create shares, and use other account features.",
      path: "/login",
      indexable: false,
    });
    return {
      ...seo,
      meta: [...seo.meta, { name: "referrer", content: "no-referrer" }],
    };
  },
});

function RouteComponent() {
  const { redirect, error, provider, link, signup, verification } = Route.useSearch();
  const socialProviders = Route.useLoaderData();
  const { session } = Route.useRouteContext();
  const [signInEmail, setSignInEmail] = useState("");
  const [showSignIn, setShowSignIn] = useState(
    !signup || error?.toLowerCase() === "account_not_linked",
  );

  return (
    <div className="min-h-svh">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <header className="flex h-16 items-center justify-between px-4 sm:px-6">
        <Link to={productHome.to} className="flex min-h-11 items-center rounded-xl text-[17px] font-semibold tracking-[-0.02em] outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
          <BrandMark className="mr-2 size-6" />
          {env.VITE_BRAND_NAME}
        </Link>
        <ModeToggle />
      </header>
      <main id="main-content" className="grid min-h-[calc(100svh-4rem)] place-items-center px-4 pb-16 pt-6">
        <div className="w-full max-w-md">
          <Link
            to={productHome.to}
            className="mb-5 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden="true" /> Back to {productHome.label}
          </Link>
          <div className="mb-7 text-center">
            <p className="text-sm font-medium text-brand">{productPitch.eyebrow}</p>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
              {productPitch.summary}
            </p>
          </div>
          <div className="rounded-2xl bg-card p-6 shadow-sm ring-1 ring-foreground/10 sm:p-8">
            {link && session.data && provider ? (
              <SocialLinkError
                provider={provider}
                redirectTo={redirect}
                errorCode={error}
                emailVerified={Boolean(verification && !error && session.data.user.emailVerified)}
              />
            ) : showSignIn ? (
              <SignInForm
                initialEmail={signInEmail}
                onSwitchToSignUp={() => setShowSignIn(false)}
                redirectTo={redirect}
                socialProviders={socialProviders}
                oauthErrorCode={verification ? (link && provider ? "account_not_linked" : undefined) : error}
                oauthProvider={provider}
                verificationError={verification ? error : undefined}
              />
            ) : (
              <SignUpForm
                onSwitchToSignIn={(email) => {
                  setSignInEmail(email ?? "");
                  setShowSignIn(true);
                }}
                redirectTo={redirect}
                socialProviders={socialProviders}
                oauthErrorCode={error}
                oauthProvider={provider}
              />
            )}
          </div>
        </div>
      </main>
      <footer className="flex flex-wrap justify-center gap-x-5 px-4 pb-8 text-xs text-muted-foreground">
        <a href="/terms" className="min-h-11 content-center">Terms</a>
        <a href="/privacy" className="min-h-11 content-center">Privacy</a>
        <a href="/privacy#analytics-controls" className="min-h-11 content-center">Privacy choices</a>
        {productFooterLinks.map(({ to, label }) => <a key={to} href={to} className="min-h-11 content-center">{label}</a>)}
      </footer>
    </div>
  );
}

function SocialLinkError({
  provider,
  redirectTo,
  errorCode,
  emailVerified,
}: {
  provider: SocialProviderId;
  redirectTo?: string;
  errorCode?: string;
  emailVerified?: boolean;
}) {
  const navigate = Route.useNavigate();
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const label = socialProviderLabels[provider];

  const retry = async () => {
    setIsRetrying(true);
    setRetryError(null);
    try {
      await authClient.linkSocial({
        provider,
        callbackURL: getAbsoluteAppURL(redirectTo),
        errorCallbackURL: getOAuthErrorURL({ provider, redirectTo, linking: true }),
      });
    } catch {
      setRetryError(`Could not start ${label} connection. Please try again.`);
    } finally {
      setIsRetrying(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{emailVerified ? `Connect ${label}` : `Couldn't connect ${label}`}</h1>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        {emailVerified ? `Your email is verified. Connect ${label} to finish signing in.`
          : ["email_does_not_match", "email_doesn't_match"].includes(errorCode?.toLowerCase() ?? "")
          ? `${label} returned a different email address. Choose the account that matches your ${env.VITE_BRAND_NAME} email.`
          : "Your password sign-in succeeded, but the social account was not connected."}
      </p>
      {retryError ? (
        <p className="mt-4 rounded-xl bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          {retryError}
        </p>
      ) : null}
      <div className="mt-6 space-y-3">
        <Button
          type="button"
          className="w-full"
          disabled={isRetrying}
          onClick={() => void retry()}
        >
          {isRetrying ? `Connecting ${label}…` : `Try ${label} again`}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="w-full text-muted-foreground"
          onClick={() => navigate({ to: redirectTo ?? productHome.to })}
        >
          Continue without connecting
        </Button>
      </div>
    </div>
  );
}
