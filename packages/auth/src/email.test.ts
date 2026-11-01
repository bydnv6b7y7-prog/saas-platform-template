import { describe, expect, test } from "bun:test";
import { createCloudflareEmailSender, createEmailSender, EmailDeliveryError } from "./email";

const environment = {
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_EMAIL_API_TOKEN: "fixture-token",
  EMAIL_FROM: "accounts@example.invalid",
};
const message = { to: "reader@example.invalid", subject: "Verify", text: "plain", html: "<p>plain</p>" };
const success = (result: object) => ({ success: true, result: { delivered: [], queued: [], permanent_bounces: [], ...result } });

describe("Cloudflare Email REST transport", () => {
  test("sends the documented payload with server credentials and bounded delivery time", async () => {
    let request: Request | undefined;
    const send = createCloudflareEmailSender(environment, async (url, init) => {
      request = new Request(url, init);
      return Response.json(success({ delivered: [message.to] }));
    });
    await send(message);
    expect(request!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${environment.CLOUDFLARE_ACCOUNT_ID}/email/sending/send`);
    expect(request!.method).toBe("POST");
    expect(request!.headers.get("authorization")).toBe("Bearer fixture-token");
    expect(request!.headers.get("content-type")).toBe("application/json");
    expect(request!.redirect).toBe("error");
    expect(request!.signal).toBeInstanceOf(AbortSignal);
    expect(await request!.json()).toEqual({ ...message, from: environment.EMAIL_FROM });
  });

  test("serializes a named sender as an address object", async () => {
    let payload: unknown;
    const send = createCloudflareEmailSender({
      ...environment,
      EMAIL_FROM: "Northwind <noreply@northwind.dev>",
    }, async (_url, init) => {
      payload = JSON.parse(init.body as string);
      return Response.json(success({ queued: [message.to] }));
    });
    await send(message);
    expect(payload).toEqual({
      ...message,
      from: { address: "noreply@northwind.dev", name: "Northwind" },
    });
  });

  test("accepts queued delivery for the intended recipient", async () => {
    const send = createCloudflareEmailSender(environment,
      async () => Response.json(success({ queued: [message.to.toUpperCase()] })));
    await expect(send(message)).resolves.toBeUndefined();
  });

  test("rejects bounced, suppressed, ambiguous, malformed and failed responses", async () => {
    const responses = [
      Response.json(success({ permanent_bounces: [message.to] })),
      Response.json(success({ suppressed_recipients: [message.to] })),
      Response.json(success({})),
      Response.json(success({ delivered: ["someone-else@example.invalid"] })),
      Response.json({ success: false, errors: [{ message: "secret-provider-details" }] }),
      Response.json({ success: true, result: {} }),
      Response.json(success({ delivered: [message.to] }), { status: 403 }),
      new Response("invalid JSON"),
    ];
    for (const response of responses) {
      const send = createCloudflareEmailSender(environment, async () => response);
      await expect(send(message)).rejects.toBeInstanceOf(EmailDeliveryError);
    }
  });

  test("does not send when unconfigured or expose network error contents", async () => {
    let called = false;
    const network = async () => {
      called = true;
      throw new Error(`secret ${environment.CLOUDFLARE_EMAIL_API_TOKEN} ${message.to}`);
    };
    await expect(createCloudflareEmailSender({}, network)(message)).rejects.toBeInstanceOf(EmailDeliveryError);
    expect(called).toBe(false);
    try {
      await createCloudflareEmailSender(environment, network)(message);
      throw new Error("Expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(EmailDeliveryError);
      expect(String(error)).not.toContain("fixture-token");
      expect(String(error)).not.toContain(message.to);
    }
  });
});

describe("development Mailpit inbox", () => {
  const message = { to: "dev@example.com", subject: "Code", text: "123456", html: "<p>123456</p>" };

  test("delivers through the Mailpit send API instead of Cloudflare", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const send = createEmailSender({ EMAIL_DEV_MAILPIT_URL: "http://localhost:8025/", CLOUDFLARE_ACCOUNT_ID: "a".repeat(32) }, async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    });
    await send(message);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://localhost:8025/api/v1/send");
    expect(calls[0]!.body).toMatchObject({ To: [{ Email: "dev@example.com" }], Subject: "Code", Text: "123456" });
  });

  test("reports failures without details and is refused in production", async () => {
    const send = createEmailSender({ EMAIL_DEV_MAILPIT_URL: "http://localhost:8025" }, async () => new Response("no", { status: 500 }));
    await expect(send(message)).rejects.toBeInstanceOf(EmailDeliveryError);
    expect(() => createEmailSender({ EMAIL_DEV_MAILPIT_URL: "http://localhost:8025", NODE_ENV: "production" })).toThrow(/production/);
  });
});
