import { EMAIL_VERIFICATION_OTP_LENGTH, EMAIL_VERIFICATION_RESEND_INTERVAL_SECONDS } from "@northwind/env/email";
import { Button } from "@northwind/ui/components/button";
import { useEffect, useRef, useState } from "react";

import { authClient } from "@/lib/auth-client";
import { getEmailOTPErrorMessage } from "@/lib/email-verification";
import { AuthErrorBanner, AuthTextField } from "./auth-form-parts";

type VerificationRequest = {
  email: string;
  status: "sending" | "sent" | "error";
  retryAt: number;
  error: string | null;
};

export function useEmailVerification() {
  const [request, setRequest] = useState<VerificationRequest | null>(null);
  const inFlight = useRef(false);

  const send = async (email: string) => {
    if (inFlight.current || (request && Date.now() < request.retryAt)) return;
    inFlight.current = true;
    const startedAt = Date.now();
    let retryAfter = EMAIL_VERIFICATION_RESEND_INTERVAL_SECONDS;
    setRequest({ email, status: "sending", retryAt: 0, error: null });
    try {
      const result = await authClient.emailOtp.sendVerificationOtp({ email, type: "email-verification" }, {
        onResponse: ({ response }) => {
          const seconds = Number(
            response.headers.get("x-retry-after") ?? response.headers.get("retry-after"),
          );
          if (Number.isFinite(seconds) && seconds > 0) retryAfter = Math.ceil(seconds);
        },
      });
      setRequest({
        email,
        status: result.error ? "error" : "sent",
        retryAt: Math.max(
          startedAt + EMAIL_VERIFICATION_RESEND_INTERVAL_SECONDS * 1_000,
          result.error?.status === 429 ? Date.now() + retryAfter * 1_000 : 0,
        ),
        error: result.error
          ? result.error.status === 429
            ? "Please wait before requesting another verification email."
            : "The verification email could not be sent. Please try again shortly."
          : null,
      });
    } catch {
      setRequest({
        email,
        status: "error",
        retryAt: startedAt + EMAIL_VERIFICATION_RESEND_INTERVAL_SECONDS * 1_000,
        error: "Could not reach the email service. Check your connection and try again.",
      });
    } finally {
      inFlight.current = false;
    }
  };

  return { request, send, reset: () => setRequest(null) };
}

export function EmailVerificationNotice({
  request,
  onResend,
  onBack,
  onVerified,
}: {
  request: VerificationRequest;
  onResend: () => void;
  onBack: () => void;
  onVerified: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [now, setNow] = useState(Date.now);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const verifyInFlight = useRef(false);
  useEffect(() => {
    if (request.status === "sending") { setCode(""); setVerificationError(null); }
    if (request.status === "sent") document.getElementById("email-verification-code")?.focus();
  }, [request.status]);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    setNow(Date.now());
    if (request.retryAt <= Date.now()) return;
    const timer = window.setInterval(() => {
      const currentTime = Date.now();
      setNow(currentTime);
      if (currentTime >= request.retryAt) window.clearInterval(timer);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [request.retryAt]);
  const seconds = Math.max(0, Math.ceil((request.retryAt - now) / 1_000));
  const sending = request.status === "sending";
  const verify = async () => {
    if (verifyInFlight.current || sending || code.length !== EMAIL_VERIFICATION_OTP_LENGTH) return;
    verifyInFlight.current = true;
    setVerifying(true);
    setVerificationError(null);
    try {
      const result = await authClient.emailOtp.verifyEmail({ email: request.email, otp: code });
      if (result.error) {
        setVerificationError(getEmailOTPErrorMessage(result.error.code, result.error.status));
        return;
      }
      const session = await authClient.getSession({ query: { disableCookieCache: true } });
      if (!session.data?.user.emailVerified || session.data.user.email.toLowerCase() !== request.email.trim().toLowerCase()) {
        setVerificationError("Your email is verified. Go back and sign in to continue on this device.");
        return;
      }
      onVerified();
    } catch {
      setVerificationError("Could not verify the code. Check your connection and try again.");
    } finally {
      verifyInFlight.current = false;
      setVerifying(false);
    }
  };

  return (
    <div className="w-full">
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
        Verify your email
      </h1>
      <p className="mb-5 mt-2 text-sm leading-6 text-muted-foreground">
        Confirm <strong className="break-all font-medium text-foreground">{request.email}</strong> to finish signing in.
      </p>
      <p role="status" className="mb-5 text-sm leading-6 text-muted-foreground">
        {sending ? "Sending your verification email…"
          : request.status === "sent"
            ? "If this email belongs to an unverified account, a six-digit code will arrive shortly. It expires in 5 minutes. Check your inbox and spam folder."
            : "Your email still needs to be verified before you can sign in."}
      </p>
      <AuthErrorBanner id="verification-email-error" message={request.error} />
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void verify(); }}>
        <AuthTextField id="email-verification-code" name="otp" label="Verification code"
          value={code} error={verificationError} onBlur={() => {}}
          onValueChange={(value) => { setCode(value.replace(/[^0-9]/g, "").slice(0, EMAIL_VERIFICATION_OTP_LENGTH)); setVerificationError(null); }}
          inputProps={{ inputMode: "numeric", autoComplete: "one-time-code", maxLength: EMAIL_VERIFICATION_OTP_LENGTH,
            pattern: "[0-9]{6}", disabled: sending || verifying, className: "text-center text-xl tracking-[0.4em]", placeholder: "000000" }} />
        <Button type="submit" className="w-full" disabled={sending || verifying || code.length !== EMAIL_VERIFICATION_OTP_LENGTH}>
          {verifying ? "Verifying…" : "Verify and continue"}
        </Button>
      </form>
      <Button type="button" variant="outline" className="mt-3 w-full" disabled={sending || verifying || seconds > 0} onClick={onResend}>
        {sending ? "Sending…" : seconds > 0 ? `Resend in ${seconds}s` : "Resend verification email"}
      </Button>
      <Button type="button" variant="link" className="mt-3 w-full" disabled={sending || verifying} onClick={onBack}>
        Back to sign in
      </Button>
    </div>
  );
}
