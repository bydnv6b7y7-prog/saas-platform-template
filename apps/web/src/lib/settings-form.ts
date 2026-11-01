import type { z } from "zod";

/** Every Admin runtime settings scope is a complete snapshot of whole-number controls. */
export type SettingsValues = Record<string, number>;

export type SettingsSchema<V extends SettingsValues> = {
  shape: { [K in keyof V]: z.ZodNumber };
  safeParse(input: unknown): z.ZodSafeParseResult<V>;
};

export type SettingsVersion<V extends SettingsValues> = { values: V; revision: number };

export type SettingsDraft<V extends SettingsValues> = Record<keyof V, string>;

export type SettingsFormState<V extends SettingsValues> = {
  baseline: SettingsVersion<V>;
  draft: SettingsDraft<V>;
  error: string | null;
  conflict: boolean;
  notice: string | null;
};

export const settingKeys = <V extends SettingsValues>(values: V) => Object.keys(values) as (keyof V & string)[];

function toDraft<V extends SettingsValues>(values: V): SettingsDraft<V> {
  return Object.fromEntries(settingKeys(values).map((key) => [key, String(values[key])])) as SettingsDraft<V>;
}

export function createSettingsForm<V extends SettingsValues>(baseline: SettingsVersion<V>): SettingsFormState<V> {
  return { baseline, draft: toDraft(baseline.values), error: null, conflict: false, notice: null };
}

export function validateSettingsDraft<V extends SettingsValues>(schema: SettingsSchema<V>, draft: SettingsDraft<V>) {
  const keys = Object.keys(schema.shape) as (keyof V & string)[];
  const result = schema.safeParse(
    Object.fromEntries(keys.map((key) => [key, draft[key].trim() === "" ? Number.NaN : Number(draft[key])])),
  );
  const errors: Partial<Record<keyof V, string>> = {};
  if (!result.success) {
    for (const issue of result.error.issues) {
      const key = issue.path[0] as keyof V & string;
      if (!keys.includes(key) || errors[key]) continue;
      const field = schema.shape[key];
      errors[key] = draft[key].trim() === ""
        ? "Enter a value."
        : issue.code === "too_small"
          ? `Enter at least ${field.minValue}.`
          : issue.code === "too_big"
            ? `Enter no more than ${field.maxValue}.`
            : "Enter a whole number.";
    }
  }
  return { values: result.success ? result.data : null, errors };
}

export function hasSettingsChanges<V extends SettingsValues>(state: SettingsFormState<V>): boolean {
  return settingKeys(state.baseline.values).some(
    (key) => state.draft[key].trim() === "" || Number(state.draft[key]) !== state.baseline.values[key],
  );
}

export type SettingsFormAction<V extends SettingsValues> =
  | { type: "edit"; key: keyof V; value: string }
  | { type: "receive"; snapshot: SettingsVersion<V> }
  | { type: "defaults"; values: V }
  | { type: "saved" | "reloaded"; snapshot: SettingsVersion<V> }
  | { type: "failed"; message: string; conflict?: boolean };

export function settingsFormReducer<V extends SettingsValues>(
  state: SettingsFormState<V>,
  action: SettingsFormAction<V>,
): SettingsFormState<V> {
  switch (action.type) {
    case "edit":
      return { ...state, draft: { ...state.draft, [action.key]: action.value }, error: null, notice: null };
    case "defaults":
      return { ...state, draft: toDraft(action.values), error: null, notice: "Recommended defaults loaded. Save changes to apply them." };
    case "receive":
      if (action.snapshot.revision === state.baseline.revision) return state;
      // A refresh must never silently replace unsaved work or advance its expected revision.
      return hasSettingsChanges(state) || state.conflict
        ? { ...state, conflict: true, notice: null }
        : createSettingsForm(action.snapshot);
    case "saved":
    case "reloaded":
      return {
        ...createSettingsForm(action.snapshot),
        notice: action.type === "saved" ? "Changes saved." : "Latest saved values loaded.",
      };
    case "failed":
      return { ...state, error: action.conflict ? null : action.message, conflict: state.conflict || Boolean(action.conflict), notice: null };
  }
}
