import type { Page } from "playwright";

import type { ProductE2E } from "../../test/e2e/golden-path";

/** A valid 1×1 PNG: the server checks the file header, not just the declared type. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const DRAFT = { title: "E2E drafted note", body: "Drafted by the assistant, saved after confirmation." };

async function addNote(page: Page, title: string, withFile: boolean) {
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Note", { exact: true }).fill(`Body of ${title}`);
  if (withFile) await page.getByLabel(/Attachment/).setInputFiles({ name: `${title}.png`, mimeType: "image/png", buffer: PNG });
  await page.getByRole("button", { name: "Save note" }).click();
}

/** Sends a message from the assistant composer, opening the sidebar first if needed. */
async function ask(page: Page, message: string) {
  const composer = page.getByPlaceholder("Ask anything…");
  if (!await composer.isVisible().catch(() => false)) await page.getByRole("button", { name: /assistant|ask|AI/i }).first().click();
  // The composer accepts input before it is wired to the run; a sent message clears it.
  for (let attempt = 0; attempt < 5; attempt++) {
    await composer.fill(message);
    await composer.press("Enter");
    if (await composer.inputValue().then((value) => value === "", () => false)) return;
    await page.waitForTimeout(1_000);
  }
  throw new Error("the assistant did not take the message");
}

export const productE2E: ProductE2E = {
  modelRules: [
    { when: /latest notes/i, tool: "listNotes", arguments: { limit: 5 } },
    { when: /draft a note/i, tool: "createNote", arguments: DRAFT },
  ],
  pages: ["/notes"],
  steps: [
    {
      name: "notes: files go straight to object storage, within the Free allowance",
      run: async ({ page, query, storedObject }) => {
        await page.goto("/notes");
        await page.getByText("Attachments: 0 of 3 on the Free plan.").waitFor();
        for (const index of [1, 2, 3]) {
          await addNote(page, `E2E note ${index}`, true);
          await page.getByTestId("note").filter({ hasText: `E2E note ${index}` }).waitFor();
        }
        await page.getByText("Attachments: 3 of 3 on the Free plan.").waitFor();
        const rows = await query<{ object_key: string; byte_length: number; confirmed_at: Date | null }>(
          "SELECT object_key, byte_length, confirmed_at FROM stored_object WHERE purpose = 'note-attachment' AND released_at IS NULL");
        if (rows.length !== 3 || rows.some((row) => !row.confirmed_at)) throw new Error(`expected 3 confirmed uploads, found ${JSON.stringify(rows)}`);
        for (const row of rows) {
          const object = await storedObject(row.object_key);
          if (object?.size !== PNG.length || object.contentType !== "image/png") throw new Error(`${row.object_key} is not in storage as uploaded`);
        }
        // A fourth file is refused before anything is signed, and the page says why.
        await addNote(page, "E2E note over quota", true);
        await page.getByRole("alert").filter({ hasText: "allowance is used up" }).waitFor();
        const count = (await query<{ count: number }>("SELECT count(*)::int AS count FROM stored_object WHERE purpose = 'note-attachment'"))[0]?.count ?? 0;
        if (count !== 3) throw new Error(`the refused upload left ${count - 3} row(s) behind`);
        return "3 uploads verified in S3; the 4th refused by the Free quota";
      },
    },
    {
      name: "notes: an attachment opens through a short-lived signed link",
      run: async ({ page }) => {
        await page.goto("/notes");
        const [tab] = await Promise.all([
          page.context().waitForEvent("page"),
          page.getByRole("button", { name: /Open attachment/ }).first().click(),
        ]);
        await tab.waitForURL(/X-Amz-Signature/i);
        const type = await tab.evaluate(() => (globalThis as unknown as { document: { contentType: string } }).document.contentType);
        await tab.close();
        if (type !== "image/png") throw new Error(`the signed link served ${type}`);
      },
    },
    {
      name: "notes: deleting a note releases its attachment for clean-up",
      run: async ({ page, query }) => {
        await page.goto("/notes");
        await page.getByRole("button", { name: "Delete E2E note 3" }).click();
        await page.getByRole("button", { name: "Delete", exact: true }).click();
        await page.getByTestId("note").filter({ hasText: "E2E note 3" }).waitFor({ state: "detached" });
        await page.getByText("Attachments: 2 of 3 on the Free plan.").waitFor();
        const released = (await query<{ released: number }>(
          "SELECT count(*)::int AS released FROM stored_object WHERE purpose = 'note-attachment' AND released_at IS NOT NULL"))[0]?.released ?? 0;
        if (released !== 1) throw new Error(`expected 1 released attachment, found ${released}`);
      },
    },
    {
      name: "assistant reads notes with a tool and shows them as a card",
      run: async ({ page, modelToolCalls }) => {
        await page.goto("/notes");
        await ask(page, "What are my latest notes?");
        const card = page.getByRole("region", { name: "Your notes" });
        await card.getByText("E2E note 2", { exact: true }).waitFor({ timeout: 45_000 });
        if (!modelToolCalls().some((call) => call.tool === "listNotes")) throw new Error("the card appeared without a listNotes call");
      },
    },
    {
      name: "assistant drafts a note that is saved only after confirmation",
      run: async ({ page, query }) => {
        await ask(page, "Draft a note for the end-to-end run");
        const draft = page.getByRole("region", { name: "Draft note" }).filter({ hasText: DRAFT.title });
        await draft.getByRole("button", { name: "Save note" }).waitFor({ timeout: 45_000 });
        const before = await query("SELECT 1 FROM note WHERE title = $1", [DRAFT.title]);
        if (before.length) throw new Error("the draft was saved before it was confirmed");
        await draft.getByRole("button", { name: "Save note" }).click();
        await draft.getByText("saved to").waitFor({ timeout: 45_000 });
        await page.getByText("E2E tool result: createNote").first().waitFor({ timeout: 45_000 });
        const after = await query("SELECT 1 FROM note WHERE title = $1", [DRAFT.title]);
        if (after.length !== 1) throw new Error(`expected the confirmed draft once, found ${after.length}`);
      },
    },
  ],
};
