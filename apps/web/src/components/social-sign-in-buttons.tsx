import { Button } from "@northwind/ui/components/button";
import { Apple } from "lucide-react";
import { useState, type ComponentType } from "react";

import { getAbsoluteAppURL } from "@/lib/app-url";
import { authClient, type SocialProviderId } from "@/lib/auth-client";
import {
  getOAuthErrorURL,
  socialProviderLabels,
} from "@/lib/social-auth";

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.91h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.4Z" />
      <path fill="#34A853" d="M12 22c2.7 0 4.97-.9 6.62-2.37l-3.24-2.54c-.9.6-2.05.96-3.38.96-2.6 0-4.81-1.76-5.6-4.13H3.06v2.61A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.4 13.92A6 6 0 0 1 6.1 12c0-.67.12-1.32.3-1.92V7.47H3.06A10 10 0 0 0 2 12c0 1.61.39 3.14 1.06 4.53l3.34-2.61Z" />
      <path fill="#EA4335" d="M12 5.95c1.47 0 2.79.51 3.83 1.5l2.87-2.87A9.64 9.64 0 0 0 12 2a10 10 0 0 0-8.94 5.47l3.34 2.61c.79-2.37 3-4.13 5.6-4.13Z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.009-.866-.014-1.7-2.782.605-3.369-1.343-3.369-1.343-.455-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.071 1.531 1.031 1.531 1.031.892 1.53 2.341 1.088 2.91.832.091-.647.349-1.088.635-1.338-2.221-.253-4.555-1.112-4.555-4.947 0-1.093.39-1.987 1.029-2.687-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.295 2.747-1.026 2.747-1.026.546 1.377.203 2.394.1 2.647.64.7 1.028 1.594 1.028 2.687 0 3.844-2.337 4.691-4.566 4.94.359.31.679.92.679 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.523 2 12 2Z"
      />
    </svg>
  );
}

const providerIcons = {
  google: GoogleIcon,
  github: GitHubIcon,
  apple: Apple,
} satisfies Record<SocialProviderId, ComponentType>;

export default function SocialSignInButtons({
  providers,
  redirectTo,
  intent = "sign-in",
  onError,
}: {
  providers: SocialProviderId[];
  redirectTo?: string;
  intent?: "sign-in" | "sign-up";
  onError: (message: string | null) => void;
}) {
  const [pendingProvider, setPendingProvider] = useState<SocialProviderId | null>(null);

  if (providers.length === 0) return null;

  const signIn = async (provider: SocialProviderId) => {
    const isSignUp = intent === "sign-up";
    setPendingProvider(provider);
    onError(null);
    try {
      await authClient.signIn.social(
        {
          provider,
          callbackURL: getAbsoluteAppURL(redirectTo),
          errorCallbackURL: getOAuthErrorURL({ provider, redirectTo, intent }),
          ...(isSignUp ? { requestSignUp: true } : {}),
        },
        {
          onError: ({ error }) => {
            onError(error.message || error.statusText || `${socialProviderLabels[provider]} sign-in failed.`);
          },
        },
      );
    } catch {
      onError(`${socialProviderLabels[provider]} sign-in failed. Please try again.`);
    } finally {
      setPendingProvider(null);
    }
  };

  return (
    <div
      className="mt-6 space-y-3"
      role="group"
      aria-label={intent === "sign-up" ? "Social sign-up options" : "Social sign-in options"}
    >
      {providers.map((provider) => {
        const Icon = providerIcons[provider];
        const label = socialProviderLabels[provider];
        return (
          <Button
            key={provider}
            type="button"
            variant="outline"
            className="w-full"
            disabled={pendingProvider !== null}
            onClick={() => void signIn(provider)}
          >
            <Icon />
            {pendingProvider === provider
              ? `Connecting to ${label}…`
              : intent === "sign-up"
                ? `Sign up with ${label}`
                : `Continue with ${label}`}
          </Button>
        );
      })}
    </div>
  );
}
