import { readCloudflareEmailConfiguration, readMailpitConfiguration } from "@northwind/env/email";
import { z } from "zod";

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export type SendEmail = (message: EmailMessage) => Promise<void>;
type EmailFetch = (url: string, init: RequestInit) => Promise<Response>;

const deliveryResponseSchema = z.object({
  success: z.literal(true),
  result: z.object({
    delivered: z.array(z.string()),
    queued: z.array(z.string()),
    permanent_bounces: z.array(z.string()),
    suppressed_recipients: z.array(z.string()).optional(),
  }),
});

export class EmailDeliveryError extends Error {
  constructor() {
    // Provider responses can contain recipients and other sensitive content.
    super("The verification email could not be sent. Please try again shortly.");
    this.name = "EmailDeliveryError";
  }
}

/** Mailpit in development (EMAIL_DEV_MAILPIT_URL), otherwise Cloudflare Email Sending. */
export function createEmailSender(environment: Record<string, unknown>, request: EmailFetch = globalThis.fetch): SendEmail {
  const mailpit = readMailpitConfiguration(environment);
  return mailpit ? createMailpitEmailSender(mailpit.url, request) : createCloudflareEmailSender(environment, request);
}

/** Delivers to a local Mailpit inbox through its HTTP send API (no SMTP client needed). */
function createMailpitEmailSender(url: string, request: EmailFetch = globalThis.fetch): SendEmail {
  return async (message) => {
    try {
      const response = await request(`${url}/api/v1/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          From: { Email: "noreply@localhost", Name: "Development" },
          To: [{ Email: message.to }],
          Subject: message.subject,
          Text: message.text,
          HTML: message.html,
        }),
      });
      if (!response.ok) throw new EmailDeliveryError();
    } catch {
      throw new EmailDeliveryError();
    }
  };
}

export function createCloudflareEmailSender(
  environment: Record<string, unknown>,
  request: EmailFetch = globalThis.fetch,
): SendEmail {
  const configuration = readCloudflareEmailConfiguration(environment);
  return async (message) => {
    if (!configuration) throw new EmailDeliveryError();
    try {
      const response = await request(
        `https://api.cloudflare.com/client/v4/accounts/${configuration.accountId}/email/sending/send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${configuration.apiToken}`,
            "Content-Type": "application/json",
          },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({ ...message, from: configuration.from }),
        },
      );
      if (!response.ok) throw new EmailDeliveryError();
      const parsed = deliveryResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new EmailDeliveryError();
      const result = parsed.data.result;
      const includesRecipient = (addresses: string[]) =>
        addresses.some((address) => address.toLowerCase() === message.to.toLowerCase());
      if (
        includesRecipient(result.permanent_bounces) ||
        includesRecipient(result.suppressed_recipients ?? []) ||
        !includesRecipient([...result.delivered, ...result.queued])
      ) {
        throw new EmailDeliveryError();
      }
    } catch {
      // Never log credentials, recipients, verification links, or raw responses.
      throw new EmailDeliveryError();
    }
  };
}
