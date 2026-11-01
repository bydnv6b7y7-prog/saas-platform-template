import { describe, expect, it } from "bun:test";
import { OPERATIONAL_SETTINGS_DEFAULTS, operationalSettingsSchema } from "@northwind/env/operational-settings";
import { renderToStaticMarkup } from "react-dom/server";

import type { OperationalSettings } from "@northwind/env/operational-settings";

import { operationalSettingsSections } from "@/components/admin/operational-settings";
import { SettingsForm } from "@/components/admin/settings-form";
import {
  createSettingsForm as createOperationalSettingsForm,
  hasSettingsChanges as hasOperationalSettingsChanges,
  settingKeys,
  settingsFormReducer,
  validateSettingsDraft,
  type SettingsFormAction,
  type SettingsFormState,
} from "./settings-form";

type OperationalSettingsFormState = SettingsFormState<OperationalSettings>;
const OPERATIONAL_SETTING_KEYS = settingKeys(OPERATIONAL_SETTINGS_DEFAULTS);
const reduce = (state: OperationalSettingsFormState, action: SettingsFormAction<OperationalSettings>) => settingsFormReducer(state, action);
const validateOperationalSettingsDraft = (draft: OperationalSettingsFormState["draft"]) => validateSettingsDraft(operationalSettingsSchema, draft);

const snapshot = { revision: 3, values: { ...OPERATIONAL_SETTINGS_DEFAULTS } };
const initial = () => createOperationalSettingsForm(snapshot);
const edited = () => reduce(initial(), { type: "edit", key: "assistantProPerDay", value: "60" });

function renderForm(state: OperationalSettingsFormState, pending = false) {
  return renderToStaticMarkup(
    <SettingsForm
      label="Operational settings"
      schema={operationalSettingsSchema}
      sections={operationalSettingsSections}
      state={state}
      pending={pending}
      reloading={false}
      onEdit={() => {}}
      onSubmit={() => {}}
      onDefaults={() => {}}
      onReload={() => {}}
    />,
  );
}

describe("settings form editing", () => {
  it("rejects blank, fractional, and out-of-range limits", () => {
    expect(validateOperationalSettingsDraft(initial().draft).values).toEqual(snapshot.values);
    for (const key of OPERATIONAL_SETTING_KEYS) {
      for (const value of ["", "1.5", String(operationalSettingsSchema.shape[key].maxValue! + 1)]) {
        const result = validateOperationalSettingsDraft({ ...initial().draft, [key]: value });
        expect(result.values).toBeNull();
        expect(result.errors[key]).toBeTruthy();
      }
    }
    expect(validateOperationalSettingsDraft({ ...initial().draft, assistantFreePerDay: "0" }).values).toBeNull();
  });

  it("compares effective numbers for dirty state and marks an emptied field as dirty", () => {
    expect(hasOperationalSettingsChanges(initial())).toBe(false);
    expect(hasOperationalSettingsChanges(reduce(initial(), { type: "edit", key: "assistantProPerDay", value: "0100" }))).toBe(false);
    expect(hasOperationalSettingsChanges(edited())).toBe(true);
    const zero = createOperationalSettingsForm({ ...snapshot, values: { ...snapshot.values, assistantProPerDay: 0 } });
    expect(hasOperationalSettingsChanges(reduce(zero, { type: "edit", key: "assistantProPerDay", value: "" }))).toBe(true);
  });

  it("shows plain field guidance using the shared bounds", () => {
    for (const key of OPERATIONAL_SETTING_KEYS) {
      const schema = operationalSettingsSchema.shape[key];
      const cases = [
        ["", "Enter a value."],
        ["1.5", "Enter a whole number."],
        ["invalid", "Enter a whole number."],
        [String(schema.minValue! - 1), `Enter at least ${schema.minValue}.`],
        [String(schema.maxValue! + 1), `Enter no more than ${schema.maxValue}.`],
      ];
      for (const [value, message] of cases) {
        const state = reduce(initial(), { type: "edit", key, value: value! });
        expect(validateOperationalSettingsDraft(state.draft).errors[key]).toBe(message);
        const markup = renderForm(state);
        expect(markup).toContain(message!);
        expect(markup).not.toContain("expected number");
      }
    }
  });

  it("preserves edits and expected revision after a failed save", () => {
    const draft = edited();
    const failed = reduce(draft, { type: "failed", message: "Connection lost" });
    expect(failed.draft).toEqual(draft.draft);
    expect(failed.baseline.revision).toBe(3);
    expect(failed.error).toBe("Connection lost");
    expect(hasOperationalSettingsChanges(failed)).toBe(true);
  });

  it("keeps a conflicting draft until the administrator explicitly loads saved values", () => {
    const latest = { revision: 4, values: { ...snapshot.values, assistantProPerDay: 75 } };
    const conflicted = reduce(edited(), { type: "failed", message: "Conflict", conflict: true });
    expect(conflicted.error).toBeNull(); // The conflict panel already explains this failure.
    expect(reduce(conflicted, { type: "failed", message: "Reload failed" }).error).toBe("Reload failed");
    const refreshed = reduce(conflicted, { type: "receive", snapshot: latest });
    expect(refreshed.conflict).toBe(true);
    expect(refreshed.draft.assistantProPerDay).toBe("60");
    expect(refreshed.baseline.revision).toBe(3);
    const reloaded = reduce(refreshed, { type: "reloaded", snapshot: latest });
    expect(reloaded.conflict).toBe(false);
    expect(reloaded.draft.assistantProPerDay).toBe("75");
    expect(reloaded.baseline.revision).toBe(4);
    expect(hasOperationalSettingsChanges(reloaded)).toBe(false);
  });

  it("refreshes pristine forms but never overwrites an unsaved draft on background refresh", () => {
    const latest = { revision: 4, values: { ...snapshot.values, assistantProPerDay: 75 } };
    expect(reduce(initial(), { type: "receive", snapshot: latest }).draft.assistantProPerDay).toBe("75");
    const refreshed = reduce(edited(), { type: "receive", snapshot: latest });
    expect(refreshed.draft.assistantProPerDay).toBe("60");
    expect(refreshed.baseline.revision).toBe(3);
    expect(refreshed.conflict).toBe(true);
  });

  it("loads recommended defaults only into the draft", () => {
    const custom = createOperationalSettingsForm({ revision: 7, values: { ...snapshot.values, assistantProPerDay: 99 } });
    const reset = reduce(custom, { type: "defaults", values: OPERATIONAL_SETTINGS_DEFAULTS });
    expect(reset.draft.assistantProPerDay).toBe("100");
    expect(reset.baseline.values.assistantProPerDay).toBe(99);
    expect(reset.baseline.revision).toBe(7);
    expect(reset.notice).toContain("Save changes to apply");
    expect(hasOperationalSettingsChanges(reset)).toBe(true);
  });

  it("uses the successful server response as the new baseline and draft", () => {
    const saved = { revision: 4, values: { ...snapshot.values, assistantProPerDay: 61 } };
    const result = reduce(edited(), { type: "saved", snapshot: saved });
    expect(result.baseline).toEqual(saved);
    expect(result.draft.assistantProPerDay).toBe("61");
    expect(result.notice).toBe("Changes saved.");
    expect(hasOperationalSettingsChanges(result)).toBe(false);
  });
});

describe("settings form semantics", () => {
  it("lists every operational setting exactly once", () => {
    expect(operationalSettingsSections.flatMap((section) => section.fields.map((field): string => field.key)).sort())
      .toEqual(Object.keys(operationalSettingsSchema.shape).sort());
  });

  it("renders four labeled integer controls in one form with one submit action", () => {
    const markup = renderForm(initial());
    expect(markup.match(/<form\b/g)).toHaveLength(1);
    expect(markup.match(/<input\b/g)).toHaveLength(4);
    expect(markup.match(/type="submit"/g)).toHaveLength(1);
    expect(markup).toContain("Free · Requests per UTC day");
    expect(markup).toContain("Pro · Requests per UTC day");
    for (const key of OPERATIONAL_SETTING_KEYS) {
      expect(markup).toContain(`for="${key}"`);
      const input = markup.match(new RegExp(`<input[^>]*id="${key}"[^>]*>`))?.[0];
      expect(input).toContain('step="1"');
      expect(input).toContain(`min="${operationalSettingsSchema.shape[key].minValue}"`);
      expect(input).toContain(`max="${operationalSettingsSchema.shape[key].maxValue}"`);
    }
    expect(markup.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(markup).not.toContain("Changes saved.");
  });

  it("enables a valid changed form and disables all edits during a save", () => {
    const changed = renderForm(edited());
    expect(changed).toContain("Unsaved changes");
    expect(changed.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).not.toContain('disabled=""');
    const pending = renderForm(edited(), true);
    expect(pending).toContain('aria-busy="true"');
    expect(pending.match(/<fieldset[^>]*disabled/g)).toHaveLength(1);
    expect(pending).toContain("Saving changes…");
    expect(pending).not.toContain("Changes saved.");
  });

  it("associates field errors and preserves the draft in failure and conflict views", () => {
    const invalid = reduce(initial(), { type: "edit", key: "assistantProPerDay", value: "" });
    const invalidMarkup = renderForm(invalid);
    expect(invalidMarkup).toContain('aria-describedby="assistantProPerDay-error"');
    expect(invalidMarkup).toContain('id="assistantProPerDay-error"');
    expect(invalidMarkup).toContain("Enter a value.");
    const conflict = reduce(edited(), { type: "failed", message: "Conflict", conflict: true });
    const markup = renderForm(conflict);
    expect(markup).toContain('value="60"');
    expect(markup).toContain("Load latest saved values");
    expect(markup).toContain("Your edits are preserved");
    expect(markup.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).toContain('disabled=""');
  });
});
