import { readFileSync } from "node:fs";
import { chromium, type Page } from "playwright";

import type { MockModelRule } from "./mock-llm";

/** What product e2e steps get (packages/product/e2e.ts). */
export type ProductE2EContext = {
  page: Page;
  apiUrl: string;
  /** A query against the test database, for checking what the UI claims. */
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  /** HEAD on the S3 stand-in: the object's size and type, or `null` when it does not exist. */
  storedObject: (key: string) => Promise<{ size: number; contentType: string | null } | null>;
  /** Tool calls the mock model has made so far. */
  modelToolCalls: () => { tool: string }[];
};

/** The product's part of the golden path: model rules, signed-in pages for the accessibility check, and steps run as a Free user. */
export type ProductE2E = {
  modelRules: readonly MockModelRule[];
  pages: readonly string[];
  steps: readonly { name: string; run: (context: ProductE2EContext) => Promise<string | void> }[];
};

export type GoldenPathConfig = {
  webUrl: string;
  apiUrl: string;
  mailpitUrl: string;
  /** Promotes the new account to administrator (the real path is ADMIN_USER_IDS or the Admin UI). */
  promoteToAdmin: (email: string) => Promise<void>;
  stripe: boolean;
  artifacts: string;
  /** Chat completion requests the mock model has served so far. */
  modelRequests: () => number;
  product: ProductE2E;
} & Omit<ProductE2EContext, "page">;

/** A valid 8×8 JPEG, so the browser check proves rendering rather than a successful download. */
const TINY_JPEG = "/9j/4AAQSkZJRgABAQAASABIAAD/4QB0RXhpZgAATU0AKgAAAAgABAEaAAUAAAABAAAAPgEbAAUAAAABAAAARgEoAAMAAAABAAIAAIdpAAQAAAABAAAATgAAAAAAAABIAAAAAQAAAEgAAAABAAKgAgAEAAAAAQAAAAigAwAEAAAAAQAAAAgAAAAA/+0AOFBob3Rvc2hvcCAzLjAAOEJJTQQEAAAAAAAAOEJJTQQlAAAAAAAQ1B2M2Y8AsgTpgAmY7PhCfv/iEaxJQ0NfUFJPRklMRQABAQAAEZxhcHBsAgAAAG1udHJHUkFZWFlaIAfcAAgAFwAPAC4AD2Fjc3BBUFBMAAAAAG5vbmUAAAAAAAAAAAAAAAAAAAAAAAD21gABAAAAANMtYXBwbAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABWRlc2MAAADAAAAAeWRzY20AAAE8AAAIGmNwcnQAAAlYAAAAI3d0cHQAAAl8AAAAFGtUUkMAAAmQAAAIDGRlc2MAAAAAAAAAH0dlbmVyaWMgR3JheSBHYW1tYSAyLjIgUHJvZmlsZQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABtbHVjAAAAAAAAAB8AAAAMc2tTSwAAAC4AAAGEZGFESwAAADoAAAGyY2FFUwAAADgAAAHsdmlWTgAAAEAAAAIkcHRCUgAAAEoAAAJkdWtVQQAAACwAAAKuZnJGVQAAAD4AAALaaHVIVQAAADQAAAMYemhUVwAAABoAAANMa29LUgAAACIAAANmbmJOTwAAADoAAAOIY3NDWgAAACgAAAPCaGVJTAAAACQAAAPqcm9STwAAACoAAAQOZGVERQAAAE4AAAQ4aXRJVAAAAE4AAASGc3ZTRQAAADgAAATUemhDTgAAABoAAAUMamFKUAAAACYAAAUmZWxHUgAAACoAAAVMcHRQTwAAAFIAAAV2bmxOTAAAAEAAAAXIZXNFUwAAAEwAAAYIdGhUSAAAADIAAAZUdHJUUgAAACQAAAaGZmlGSQAAAEYAAAaqaHJIUgAAAD4AAAbwcGxQTAAAAEoAAAcuYXJFRwAAACwAAAd4cnVSVQAAADoAAAekZW5VUwAAADwAAAfeAFYBYQBlAG8AYgBlAGMAbgDhACAAcwBpAHYA4QAgAGcAYQBtAGEAIAAyACwAMgBHAGUAbgBlAHIAaQBzAGsAIABnAHIA5QAgADIALAAyACAAZwBhAG0AbQBhAC0AcAByAG8AZgBpAGwARwBhAG0AbQBhACAAZABlACAAZwByAGkAcwBvAHMAIABnAGUAbgDoAHIAaQBjAGEAIAAyAC4AMgBDHqUAdQAgAGgA7ABuAGgAIABNAOAAdQAgAHgA4QBtACAAQwBoAHUAbgBnACAARwBhAG0AbQBhACAAMgAuADIAUABlAHIAZgBpAGwAIABHAGUAbgDpAHIAaQBjAG8AIABkAGEAIABHAGEAbQBhACAAZABlACAAQwBpAG4AegBhAHMAIAAyACwAMgQXBDAEMwQwBDsETAQ9BDAAIABHAHIAYQB5AC0EMwQwBDwEMAAgADIALgAyAFAAcgBvAGYAaQBsACAAZwDpAG4A6QByAGkAcQB1AGUAIABnAHIAaQBzACAAZwBhAG0AbQBhACAAMgAsADIAwQBsAHQAYQBsAOEAbgBvAHMAIABzAHoA/AByAGsAZQAgAGcAYQBtAG0AYQAgADIALgAykBp1KHBwlo5RSV6mADIALgAygnJfaWPPj/DHfLwYACDWjMDJACCsELnIACAAMgAuADIAINUEuFzTDMd8AEcAZQBuAGUAcgBpAHMAawAgAGcAcgDlACAAZwBhAG0AbQBhACAAMgAsADIALQBwAHIAbwBmAGkAbABPAGIAZQBjAG4A4QAgAWEAZQBkAOEAIABnAGEAbQBhACAAMgAuADIF0gXQBd4F1AAgBdAF5AXVBegAIAXbBdwF3AXZACAAMgAuADIARwBhAG0AYQAgAGcAcgBpACAAZwBlAG4AZQByAGkAYwEDACAAMgAsADIAQQBsAGwAZwBlAG0AZQBpAG4AZQBzACAARwByAGEAdQBzAHQAdQBmAGUAbgAtAFAAcgBvAGYAaQBsACAARwBhAG0AbQBhACAAMgAsADIAUAByAG8AZgBpAGwAbwAgAGcAcgBpAGcAaQBvACAAZwBlAG4AZQByAGkAYwBvACAAZABlAGwAbABhACAAZwBhAG0AbQBhACAAMgAsADIARwBlAG4AZQByAGkAcwBrACAAZwByAOUAIAAyACwAMgAgAGcAYQBtAG0AYQBwAHIAbwBmAGkAbGZukBpwcF6mfPtlcAAyAC4AMmPPj/Blh072TgCCLDCwMOwwpDCsMPMw3gAgADIALgAyACAw1zDtMNUwoTCkMOsDkwO1A70DuQO6A8wAIAOTA7oDwQO5ACADkwOsA7wDvAOxACAAMgAuADIAUABlAHIAZgBpAGwAIABnAGUAbgDpAHIAaQBjAG8AIABkAGUAIABjAGkAbgB6AGUAbgB0AG8AcwAgAGQAYQAgAEcAYQBtAG0AYQAgADIALAAyAEEAbABnAGUAbQBlAGUAbgAgAGcAcgBpAGoAcwAgAGcAYQBtAG0AYQAgADIALAAyAC0AcAByAG8AZgBpAGUAbABQAGUAcgBmAGkAbAAgAGcAZQBuAOkAcgBpAGMAbwAgAGQAZQAgAGcAYQBtAG0AYQAgAGQAZQAgAGcAcgBpAHMAZQBzACAAMgAsADIOIw4xDgcOKg41DkEOAQ4hDiEOMg5ADgEOIw4iDkwOFw4xDkgOJw5EDhsAIAAyAC4AMgBHAGUAbgBlAGwAIABHAHIAaQAgAEcAYQBtAGEAIAAyACwAMgBZAGwAZQBpAG4AZQBuACAAaABhAHIAbQBhAGEAbgAgAGcAYQBtAG0AYQAgADIALAAyACAALQBwAHIAbwBmAGkAaQBsAGkARwBlAG4AZQByAGkBDQBrAGkAIABHAHIAYQB5ACAARwBhAG0AbQBhACAAMgAuADIAIABwAHIAbwBmAGkAbABVAG4AaQB3AGUAcgBzAGEAbABuAHkAIABwAHIAbwBmAGkAbAAgAHMAegBhAHIAbwFbAGMAaQAgAGcAYQBtAG0AYQAgADIALAAyBjoGJwZFBicAIAAyAC4AMgAgBkQGSAZGACAGMQZFBicGLwZKACAGOQYnBkUEHgQxBEkEMARPACAEQQQ1BEAEMARPACAEMwQwBDwEPAQwACAAMgAsADIALQQ/BEAEPgREBDgEOwRMAEcAZQBuAGUAcgBpAGMAIABHAHIAYQB5ACAARwBhAG0AbQBhACAAMgAuADIAIABQAHIAbwBmAGkAbABlAAB0ZXh0AAAAAENvcHlyaWdodCBBcHBsZSBJbmMuLCAyMDEyAABYWVogAAAAAAAA81EAAQAAAAEWzGN1cnYAAAAAAAAEAAAAAAUACgAPABQAGQAeACMAKAAtADIANwA7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";

export type StepResult = { step: string; status: "passed" | "failed" | "skipped"; ms: number; detail?: string };

/** Sign-up with an emailed code, the assistant, a feedback screenshot through object storage, Admin, and billing. */
export async function runGoldenPath(config: GoldenPathConfig): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: config.webUrl, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  // Uncaught browser errors are reported with the step that fails after them.
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message.split("\n")[0]!));
  const email = `e2e-${Date.now()}@example.com`;
  const password = `E2e-${crypto.randomUUID()}`;

  const step = async (name: string, run: () => Promise<string | void>, skip?: string) => {
    if (skip) {
      results.push({ step: name, status: "skipped", ms: 0, detail: skip });
      return;
    }
    const started = performance.now();
    try {
      const detail = await run();
      results.push({ step: name, status: "passed", ms: Math.round(performance.now() - started), ...(detail ? { detail } : {}) });
      await page.screenshot({ path: `${config.artifacts}/${String(results.length).padStart(2, "0")}-${name.replace(/\W+/g, "-")}.png` }).catch(() => {});
    } catch (error) {
      await page.screenshot({ path: `${config.artifacts}/${name.replace(/\W+/g, "-")}.png`, fullPage: true }).catch(() => {});
      const browserError = pageErrors.length ? ` (browser: ${pageErrors.at(-1)})` : "";
      results.push({ step: name, status: "failed", ms: Math.round(performance.now() - started), detail: `${String((error as Error).message).split("\n")[0]}${browserError}` });
    }
  };
  const failed = () => results.some((result) => result.status === "failed");

  await step("home page renders", async () => {
    const response = await page.goto("/");
    if (response?.status() !== 200) throw new Error(`GET / returned ${response?.status()}`);
    await page.locator("h1").first().waitFor();
  });

  await step("sign up and verify the emailed code", async () => {
    await page.goto("/login?signup=true");
    await page.locator("#sign-up-name").fill("E2E User");
    await page.locator("#sign-up-email").fill(email);
    await page.locator("#sign-up-password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.locator("#email-verification-code").waitFor();
    const code = await readCode(config.mailpitUrl, email);
    await page.locator("#email-verification-code").fill(code);
    await page.getByRole("button", { name: "Verify and continue" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
    const session = await page.request.get(`${config.apiUrl}/api/auth/get-session`);
    const body = await session.json();
    if (body?.user?.email !== email || body.user.emailVerified !== true) throw new Error("no verified session after verification");
    return `account ${email}`;
  });

  await step("assistant answers through the configured model", async () => {
    await openAssistant(page);
    const input = page.getByRole("textbox").last();
    // The composer accepts input before it is wired to the run; a sent message clears it.
    for (let attempt = 0; attempt < 5; attempt++) {
      await input.fill("hello from the golden path");
      await input.press("Enter");
      if (await input.inputValue().then((value) => value === "", () => false)) break;
      await page.waitForTimeout(1_000);
    }
    const before = config.modelRequests();
    await page.getByText("E2E reply: hello from the golden path").first().waitFor({ timeout: 45_000 });
    if (config.modelRequests() <= before) throw new Error("the reply was shown without a model request");
    return `${config.modelRequests() - before} model request(s)`;
  }, failed() ? "sign-up failed" : undefined);

  // Product steps run as a Free user, before Checkout and the Admin promotion.
  for (const productStep of config.product.steps) {
    await step(productStep.name, () => productStep.run({ ...config, page }), failed() ? "earlier step failed" : undefined);
  }

  await step("signed-in pages have no serious accessibility violations", async () => {
    const axe = readFileSync(new URL("../../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
    const problems: string[] = [];
    for (const path of ["/", "/pricing", "/account/billing", ...config.product.pages]) {
      await page.goto(path);
      await page.locator("h1").first().waitFor();
      await page.addScriptTag({ content: axe });
      const violations = await page.evaluate(async () => {
        const result = await (globalThis as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } })
          .axe.run((globalThis as unknown as { document: unknown }).document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
        return result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")
          .map((violation) => `${violation.id} at ${violation.nodes.map((node) => node.target.join(" ")).slice(0, 3).join(", ")}`);
      });
      if (violations.length) problems.push(`${path}: ${violations.join(", ")}`);
    }
    if (problems.length) throw new Error(problems.join("; "));
  }, failed() ? "earlier step failed" : undefined);

  await step("Stripe Checkout with a test card activates Pro", async () => {
    await page.goto("/pricing");
    // Before the Admin steps: administrators get Pro without a subscription and see no checkout button.
    await page.getByRole("button", { name: "Start Pro" }).click();
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });
    // With several payment methods enabled, Checkout shows card fields only after "Card" is chosen.
    const cardNumber = page.locator("#cardNumber");
    if (!await cardNumber.isVisible().catch(() => false)) {
      // The accordion's button has no box (0×0), so it cannot be clicked by position; dispatch the click.
      await page.locator("[data-testid='card-accordion-item-button']").dispatchEvent("click");
    }
    await cardNumber.fill("4242424242424242");
    await page.locator("#cardExpiry").fill("12 / 34");
    await page.locator("#cardCvc").fill("123");
    const name = page.locator("#billingName");
    if (await name.isVisible().catch(() => false)) await name.fill("E2E User");
    const postal = page.locator("#billingPostalCode");
    if (await postal.isVisible().catch(() => false)) await postal.fill("94103");
    // Link's "save my information" is pre-checked and would require a phone number.
    const saveWithLink = page.getByRole("checkbox", { name: /Save my information/i });
    if (await saveWithLink.isChecked().catch(() => false)) await saveWithLink.uncheck({ force: true });
    await page.locator("[data-testid='hosted-payment-submit-button']").click();
    await page.waitForURL((url) => url.origin === new URL(config.webUrl).origin, { timeout: 60_000 });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const status = await (await page.request.get(`${config.apiUrl}/api/billing/status`)).json().catch(() => null);
      if (JSON.stringify(status).match(/"plan":"pro"|"active":true|"status":"active"/)) return "subscription active";
      await Bun.sleep(2_000);
    }
    throw new Error("billing status did not become active within 60 s of returning from Checkout");
  }, !config.stripe ? "no Stripe test keys (E2E_STRIPE_*)" : failed() ? "earlier step failed" : undefined);


  let feedbackMessage = "";
  await step("feedback screenshot is uploaded to object storage", async () => {
    const installationId = crypto.randomUUID();
    const jpeg = Uint8Array.from(atob(TINY_JPEG), (char) => char.charCodeAt(0));
    const reserve = await fetch(`${config.apiUrl}/api/app/feedback/uploads`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ installationId, byteLength: jpeg.length }),
    });
    if (reserve.status !== 201) throw new Error(`upload reservation returned ${reserve.status}: ${await reserve.text()}`);
    const ticket = await reserve.json() as { uploadId: string; url: string; headers: Record<string, string> };
    const put = await fetch(ticket.url, { method: "PUT", body: jpeg, headers: ticket.headers });
    if (!put.ok) throw new Error(`presigned upload returned ${put.status}`);
    feedbackMessage = `E2E feedback ${installationId.slice(0, 8)}`;
    const submit = await fetch(`${config.apiUrl}/api/app/feedback`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ installationId, category: "bug", message: feedbackMessage, screenshotUploadId: ticket.uploadId }),
    });
    if (submit.status >= 300) throw new Error(`feedback returned ${submit.status}: ${await submit.text()}`);
  });

  await step("administrator sees the feedback and its screenshot", async () => {
    await config.promoteToAdmin(email);
    await page.goto("/admin/feedback");
    await page.getByText(feedbackMessage).first().click();
    const image = page.locator("img[src*='X-Amz-Signature'], img[src*='x-amz-signature']").first();
    await image.waitFor({ timeout: 20_000 });
    // The browser must actually render it: storage CORS/CSP problems only show up here.
    await page.waitForFunction((element) => (element as unknown as { complete: boolean }).complete, await image.elementHandle());
    const width = await image.evaluate((element) => (element as unknown as { naturalWidth: number }).naturalWidth);
    if (!width) throw new Error("the screenshot did not render in the browser");
  }, failed() ? "earlier step failed" : undefined);

  await step("administrator saves an operational setting with audit", async () => {
    await page.goto("/admin/config");
    const field = page.getByLabel("Free · Requests per UTC day");
    await field.fill(String(Number(await field.inputValue()) + 1));
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByText("Changes saved.").waitFor();
    await page.getByText(/Revision \d+/).first().waitFor();
  }, failed() ? "earlier step failed" : undefined);

  await browser.close();
  return results;
}

async function openAssistant(page: Page) {
  const launcher = page.getByRole("button", { name: /assistant|ask|AI/i }).first();
  await launcher.click();
}

/** Reads the six-digit code from the newest Mailpit message to `email`. */
async function readCode(mailpitUrl: string, email: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const search = await fetch(`${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`).then((response) => response.json()) as { messages?: { ID: string }[] };
    const id = search.messages?.[0]?.ID;
    if (id) {
      const message = await fetch(`${mailpitUrl}/api/v1/message/${id}`).then((response) => response.json()) as { Text?: string };
      const code = message.Text?.match(/\b(\d{6})\b/)?.[1];
      if (code) return code;
    }
    await Bun.sleep(500);
  }
  throw new Error(`no verification email for ${email} in Mailpit`);
}
