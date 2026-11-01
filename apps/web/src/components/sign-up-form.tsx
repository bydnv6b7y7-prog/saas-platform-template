import { useForm } from "@tanstack/react-form";
import { useState } from "react";

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
import { authClient, type SocialProviderId } from "@/lib/auth-client";
import { signUpFormValidators } from "@/lib/auth-form-validation";
import { getOAuthErrorMessage } from "@/lib/social-auth";
import { getEmailVerificationCallbackURL } from "@/lib/email-verification";

export default function SignUpForm({
  onSwitchToSignIn,
  redirectTo,
  socialProviders,
  oauthErrorCode,
  oauthProvider,
}: {
  onSwitchToSignIn: (email?: string) => void;
  redirectTo?: string;
  socialProviders: SocialProviderId[];
  oauthErrorCode?: string;
  oauthProvider?: SocialProviderId;
}) {
  const verification = useEmailVerification();
  const [authError, setAuthError] = useState<string | null>(() =>
    getOAuthErrorMessage(oauthErrorCode, oauthProvider),
  );
  const form = useForm({
    defaultValues: {
      email: "",
      password: "",
      name: "",
    },
    onSubmit: async ({ value }) => {
      setAuthError(null);
      try {
        await authClient.signUp.email(
          {
            email: value.email,
            password: value.password,
            name: value.name,
          },
          {
            onSuccess: async () => {
              await verification.send(value.email);
            },
            onError: (error) => {
              setAuthError(
                error.error.message ||
                  error.error.statusText ||
                  "Account creation failed. Please try again.",
              );
            },
          },
        );
      } catch {
        setAuthError("Account creation could not be completed. Check your connection and try again.");
      }
    },
    validators: signUpFormValidators,
    onSubmitInvalid: () => focusFirstInvalidAuthField("sign-up-form"),
  });

  const verificationRequest = verification.request;
  if (verificationRequest) {
    return (
      <EmailVerificationNotice
        request={verificationRequest}
        onResend={() => { void verification.send(verificationRequest.email); }}
        onVerified={() => window.location.assign(getEmailVerificationCallbackURL(redirectTo))}
        onBack={() => {
          onSwitchToSignIn(verificationRequest.email);
          window.requestAnimationFrame(() => document.getElementById("sign-in-password")?.focus());
        }}
      />
    );
  }

  return (
    <div className="w-full">
      <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
      <p className="mt-1 text-sm text-muted-foreground">We’ll email you a six-digit code to verify your address.</p>

      <SocialSignInButtons
        providers={socialProviders}
        redirectTo={redirectTo}
        intent="sign-up"
        onError={setAuthError}
      />

      <AuthSocialDivider visible={socialProviders.length > 0} />
      <AuthErrorBanner id="sign-up-auth-error" message={authError} />

      <form
        id="sign-up-form"
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          form.handleSubmit();
        }}
        className={socialProviders.length > 0 ? "space-y-4" : "mt-6 space-y-4"}
      >
        <form.Field name="name">
          {(field) => (
            <AuthTextField
              id="sign-up-name"
              name="name"
              label="Name"
              value={field.state.value}
              error={field.state.meta.isTouched ? (field.state.meta.errors[0]?.message ?? null) : null}
              onBlur={field.handleBlur}
              onValueChange={(value) => {
                setAuthError(null);
                field.handleChange(value);
              }}
              inputProps={{ autoComplete: "name" }}
            />
          )}
        </form.Field>

        <form.Field name="email">
          {(field) => (
            <AuthTextField
              id="sign-up-email"
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
              id="sign-up-password"
              name="password"
              label="Password"
              value={field.state.value}
              error={field.state.meta.isTouched ? (field.state.meta.errors[0]?.message ?? null) : null}
              onBlur={field.handleBlur}
              onValueChange={(value) => {
                setAuthError(null);
                field.handleChange(value);
              }}
              autoComplete="new-password"
            />
          )}
        </form.Field>

        <form.Subscribe
          selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
        >
          {({ canSubmit, isSubmitting }) => (
            <AuthSubmitButton
              canSubmit={canSubmit}
              idleLabel="Create account"
              isSubmitting={isSubmitting}
              pendingLabel="Creating account…"
            />
          )}
        </form.Subscribe>
      </form>

      <AuthSwitchFooter
        prompt="Already have an account?"
        actionLabel="Sign in"
        onAction={() => onSwitchToSignIn()}
      />
    </div>
  );
}
