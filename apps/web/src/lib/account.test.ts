import { afterEach, describe, expect, it } from "bun:test";

import { deleteAccount } from "./account";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

describe("deleteAccount", () => {
  it("posts the typed email to the account-deletion endpoint", async () => {
    const calls = stubFetch(200, { success: true });
    await deleteAccount("user@example.com");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/api/auth/account/delete");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.credentials).toBe("include");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      email: "user@example.com",
    });
  });

  it("surfaces the server message for confirmation mismatches", async () => {
    stubFetch(400, {
      code: "EMAIL_CONFIRMATION_MISMATCH",
      message: "The email you entered does not match this account.",
    });
    await expect(deleteAccount("wrong@example.com")).rejects.toThrow(
      "The email you entered does not match this account.",
    );
  });

  it("falls back to a generic message on unparseable failures", async () => {
    stubFetch(503, null);
    await expect(deleteAccount("user@example.com")).rejects.toThrow(
      "Your account could not be deleted. Try again.",
    );
  });
});
