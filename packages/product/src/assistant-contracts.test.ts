import { describe, expect, test } from "bun:test";

import {
  ASSISTANT_PAGE_TOOL_NAMES,
  CREATE_NOTE_TOOL,
  createNoteInputSchema,
  createNoteResultSchema,
  listNotesResultSchema,
  toListNotesResult,
} from "./assistant-contracts";

describe("assistant tool contracts", () => {
  test("what the server tool returns is what the web renderer parses", () => {
    const result = toListNotesResult([
      { id: crypto.randomUUID(), title: "Groceries", body: "milk\n\n eggs  ".repeat(40), createdAt: new Date("2026-11-01T00:00:00Z"), attachment: null },
      { id: crypto.randomUUID(), title: "Receipt", body: "", createdAt: new Date("2026-11-01T01:00:00Z"), attachment: { id: crypto.randomUUID() } },
    ]);
    // The renderer receives the result as JSON text.
    const parsed = listNotesResultSchema.parse(JSON.parse(JSON.stringify(result)));
    expect(parsed.notes.map((note) => note.hasAttachment)).toEqual([false, true]);
    expect(parsed.notes[0]!.excerpt.length).toBeLessThanOrEqual(160);
    expect(parsed.notes[0]!.excerpt).not.toContain("\n");
  });

  test("the confirmation tool is registered as a page tool, so its result is never replayed as history", () => {
    expect(ASSISTANT_PAGE_TOOL_NAMES).toContain(CREATE_NOTE_TOOL.name);
  });

  test("a create-note draft and both outcomes round-trip", () => {
    expect(createNoteInputSchema.parse({ title: " Plan ", body: "Ship it" })).toEqual({ title: "Plan", body: "Ship it" });
    expect(createNoteInputSchema.safeParse({ title: "", body: "" }).success).toBe(false);
    expect(createNoteResultSchema.parse({ ok: false, code: "declined" })).toEqual({ ok: false, code: "declined" });
    expect(createNoteResultSchema.safeParse({ ok: true }).success).toBe(false);
  });
});
