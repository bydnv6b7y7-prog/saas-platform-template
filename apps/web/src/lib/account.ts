import { authBaseURL } from "./auth-client";

type DeleteAccountResponse = {
  success?: boolean;
  message?: string;
};

/**
 * Self-service account deletion. Calls the better-auth plugin endpoint
 * directly (same path the native iOS client uses) with the session cookie;
 * the server re-validates the typed email against the session.
 */
export async function deleteAccount(email: string) {
  const response = await fetch(new URL("account/delete", `${authBaseURL}/`), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });

  const body = (await response.json().catch(() => null)) as DeleteAccountResponse | null;
  if (!response.ok || !body?.success) {
    throw new Error(
      body?.message || "Your account could not be deleted. Try again.",
    );
  }
}
