# Example: My notes

**English** | [简体中文](example-notes.zh-CN.md)

A small, complete feature built only on platform pieces, meant to be read and then replaced.

| Platform piece | Where the example uses it |
| --- | --- |
| Per-user data with account deletion | `packages/product/src/schema/notes.ts`: `note.user_id` cascades on account deletion |
| Object storage, browser-direct upload | `packages/product/src/notes.ts` registers the `note-attachment` purpose (PNG/JPEG/PDF, 5 MB, links valid 10 minutes); `apps/web/src/product/notes/upload.ts` reserves, uploads straight to the bucket, then confirms |
| Free/Pro allowance | the purpose's `quota`: Free keeps 3 attachments, Pro 100; the page shows usage and the refusal |
| Clean-up | deleting a note releases its attachment in the same transaction; deleting the account orphans it; the hourly clean-up deletes both from storage |
| Assistant, read-only tool | `listNotes` in `apps/server/src/product/index.ts` reads only the signed-in user's notes (titles and excerpts) and is shown as a card by `apps/web/src/product/notes/assistant.tsx` |
| Assistant, confirm before acting | `createNote` is a browser tool (`useHumanInTheLoop`): the draft is saved only when the user presses Save; it is listed in `ASSISTANT_PAGE_TOOL_NAMES`, so a replayed thread never saves again |
| One contract for both sides | `packages/product/src/assistant-contracts.ts`; `assistant-contracts.test.ts` fails if the server result stops parsing in the renderer |
| Admin | `/admin/notes`: totals only, never note contents |
| Analytics | `note_created` (`source`, `has_attachment`), declared in `apps/web/src/product/analytics.ts` |
| End-to-end | `packages/product/e2e.ts`: uploads verified in the S3 stand-in, quota refusal, signed view link, release on delete, the tool card and the confirmation; the mock model calls the tools in the DeepSeek/OpenAI `tool_calls` format |

Browser uploads need the bucket's CORS rules: `bun run storage:cors` (local) or `bun run storage:cors --deploy`.

## Removing it

1. Delete `packages/product/src/notes.ts`, `packages/product/src/routers/notes.ts`, `packages/product/src/schema/notes.ts`,
   `apps/web/src/product/notes/`, `apps/web/src/routes/_auth/(product)/notes.tsx`,
   `apps/web/src/routes/admin/(product)/notes.tsx`, this file and its Chinese copy `example-notes.zh-CN.md`.
2. Run `bun run check-types`; each error points at a line that wires the example in (router, schema index, assistant
   contracts and tools, navigation, admin tab, suggestions, `e2e.ts`). Remove those lines, and the `note_created`
   event in `apps/web/src/product/analytics.ts`.
3. `bun run db:generate` writes the migration that drops `note`.
