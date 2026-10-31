import { useForm } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import {
  AuthErrorBanner,
  AuthPasswordField,
  AuthSocialDivider,
  AuthSubmitButton,
  AuthSwitchFooter,
  AuthTextField,
  focusFirstInvalidAuthField,
} from "@/components/auth-form-parts";
import {
  EmailVerificationNotice,
  useEmailVerification,
} from "@/components/email-verification-notice";
import SocialSignInButtons from "@/components/social-sign-in-buttons";
import { getAbsoluteAppURL } from "@/lib/app-url";
import { authClient, type SocialProviderId } from "@/lib/auth-client";
import { signInFormValidators } from "@/lib/auth-form-validation";
import {
  getEmailVerificationCallbackURL,
  getEmailVerificationErrorMessage,
} from "@/lib/email-verification";
import {
  getOAuthErrorMessage,
  getOAuthErrorURL,
  socialProviderLabels,
} from "@/lib/social-auth";
import { productHome } from "@/product";

export default function SignInForm({
  onSwitchToSignUp,
  redirectTo,
  socialProviders,
  oauthErrorCode,
  oauthProvider,
  verificationError,
  initialEmail = "",
}: {
  onSwitchToSignUp: () => void;
  redirectTo?: string;
  socialProviders: SocialProviderId[];
  oauthErrorCode?: string;
  oauthProvider?: SocialProviderId;
  verificationError?: string;
  initialEmail?: string;
}) {
  const navigate = useNavigate({
    from: "/",
  });
  const [authError, setAuthError] = useState<string | null>(() =>
    getEmailVerificationErrorMessage(verificationError) ??
      getOAuthErrorMessage(oauthErrorCode, oauthProvider),
  );
  const verification = useEmailVerification();
  const form = useForm({
    defaultValues: {
      email: initialEmail,
      password: "",
    },
    onSubmit: async ({ value }) => {
      setAuthError(null);
      try {
        await authClient.signIn.email(
          {
            email: value.email,
            password: value.password,
          },
          {
            onSuccess: async () => {
              if (oauthErrorCode?.toLowerCase() === "account_not_linked" && oauthProvider) {
                toast.success(`Password confirmed. Connecting ${socialProviderLabels[oauthProvider]}…`);
                try {
                  await authClient.linkSocial(
                    {
                      provider: oauthProvider,
                      callbackURL: getAbsoluteAppURL(redirectTo),
                      errorCallbackURL: getOAuthErrorURL({
                        provider: oauthProvider,
                        redirectTo,
                        linking: true,
                      }),
                    },
                    {
                      onError: ({ error }) => {
                        setAuthError(
                          error.message || error.statusText || "The social account could not be connected.",
                        );
                      },
                    },
                  );
                } catch {
                  setAuthError("The social account could not be connected. Please try again.");
                }
                return;
              }
              navigate({
                to: redirectTo ?? productHome.to,
              });
              toast.success("Welcome back");
            },
            onError: async (error) => {
              if (error.error.code === "EMAIL_NOT_VERIFIED") {
                await verification.send(value.email);
                return;
              }
              setAuthError(
                error.error.message || error.error.statusText || "Sign-in failed. Check your email and password.",
              );
            },
          },
        );
      } catch {
        setAuthError("Sign-in could not be completed. Check your connection and try again.");
      }
    },
    validators: signInFormValidators,
    onSubmitInvalid: () => focusFirstInvalidAuthField("sign-in-form"),
  });

  const verificationRequest = verification.request;
  if (verificationRequest) {
    return (
      <EmailVerificationNotice
        request={verificationRequest}
        onResend={() => { void verification.send(verificationRequest.email); }}
        onVerified={() => window.location.assign(getEmailVerificationCallbackURL(
          redirectTo, oauthErrorCode?.toLowerCase() === "account_not_linked" ? oauthProvider : undefined,
        ))}
        onBack={() => {
          form.setFieldValue("email", verificationRequest.email);
          form.setFieldValue("password", "");
          verification.reset();
          window.requestAnimationFrame(() => document.getElementById("sign-in-password")?.focus());
        }}
      />
    );
  }

  return (
    <div className="w-full">
      <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
      <p className="mt-1 text-sm text-muted-foreground">Sign in to run searches, save validations, and create shares.</p>

      <SocialSignInButtons
        providers={socialProviders}
        redirectTo={redirectTo}
        onError={setAuthError}
      />

      <AuthSocialDivider visible={socialProviders.length > 0} />
      <AuthErrorBanner id="sign-in-auth-error" message={authError} />

      <form
        id="sign-in-form"
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          form.handleSubmit();
        }}
        className={socialProviders.length > 0 ? "space-y-4" : "mt-6 space-y-4"}
      >
        <form.Field name="email">
          {(field) => (
            <AuthTextField
              id="sign-in-email"
              name="email"
              label="Email"
              value={field.state.value}
              error={field.state.meta.isTouched ? (field.state.meta.errors[0]?.message ?? null) : null}
              onBlur={field.handleBlur}
              onValueChange={(value) => {
                setAuthError(null);
                field.handleChange(value);
              }}
              inputProps={{
                type: "email",
                autoComplete: "email",
                inputMode: "email",
                autoCapitalize: "none",
              }}
            />
          )}
        </form.Field>

        <form.Field name="password">
          {(field) => (
            <AuthPasswordField
              id="sign-in-password"
              name="password"
              label="Password"
              value={field.state.value}
              error={field.state.meta.isTouched ? (field.state.meta.errors[0]?.message ?? null) : null}
              onBlur={field.handleBlur}
              onValueChange={(value) => {
                setAuthError(null);
                field.handleChange(value);
              }}
              autoComplete="current-password"
              labelAside={
                <details className="text-xs text-muted-foreground">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/30">
                    Forgot password?
                  </summary>
                  <p className="mb-2 max-w-xs rounded-xl bg-muted p-3 text-left leading-5 text-muted-foreground">
                    Password-reset email is not enabled yet. Contact support so account
                    ownership can be verified safely.
                  </p>
                </details>
              }
            />
          )}
        </form.Field>

        <form.Subscribe
          selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
        >
          {({ canSubmit, isSubmitting }) => (
            <AuthSubmitButton
              canSubmit={canSubmit}
              idleLabel="Sign in"
              isSubmitting={isSubmitting}
              pendingLabel="Signing in…"
            />
          )}
        </form.Subscribe>
      </form>

      <AuthSwitchFooter
        prompt="New here?"
        actionLabel="Create an account"
        onAction={onSwitchToSignUp}
      />
    </div>
  );
}
