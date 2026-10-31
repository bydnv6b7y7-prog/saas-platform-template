import { Button } from "@northwind/ui/components/button";
import { Card } from "@northwind/ui/components/card";
import { Input } from "@northwind/ui/components/input";
import { RotateCcw, Save } from "lucide-react";
import type { FormEvent } from "react";

import {
  hasSettingsChanges,
  validateSettingsDraft,
  type SettingsFormState,
  type SettingsSchema,
  type SettingsValues,
} from "@/lib/settings-form";

/** One fieldset of an Admin settings form; together the sections must list every key of the schema. */
export type SettingsSection<V extends SettingsValues> = {
  title: string;
  description: string;
  fields: { key: keyof V & string; label: string }[];
};

export function SettingsForm<V extends SettingsValues>({
  label,
  schema,
  sections,
  state,
  pending,
  reloading,
  onEdit,
  onSubmit,
  onDefaults,
  onReload,
}: {
  label: string;
  schema: SettingsSchema<V>;
  sections: SettingsSection<V>[];
  state: SettingsFormState<V>;
  pending: boolean;
  reloading: boolean;
  onEdit: (key: keyof V & string, value: string) => void;
  onSubmit: (values: V) => void;
  onDefaults: () => void;
  onReload: () => void;
}) {
  const validation = validateSettingsDraft(schema, state.draft);
  const dirty = hasSettingsChanges(state);
  const busy = pending || reloading;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || state.conflict || !dirty || !validation.values) return;
    onSubmit(validation.values);
  };
  const field = ({ key, label: fieldLabel }: SettingsSection<V>["fields"][number]) => {
    const error = validation.errors[key];
    const bounds = schema.shape[key];
    return (
      <div key={key} className="min-w-0">
        <label htmlFor={key} className="mb-2 block text-sm font-medium">{fieldLabel}</label>
        <Input
          id={key}
          name={key}
          type="number"
          inputMode="numeric"
          step={1}
          min={bounds.minValue ?? undefined}
          max={bounds.maxValue ?? undefined}
          required
          value={state.draft[key]}
          onChange={(event) => onEdit(key, event.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${key}-error` : undefined}
          className="tabular-nums"
        />
        {error ? <p id={`${key}-error`} className="mt-2 text-xs text-destructive">{error}</p> : null}
      </div>
    );
  };

  return (
    <form onSubmit={submit} aria-label={label} aria-busy={busy} noValidate>
      <Card className="gap-0 overflow-hidden py-0">
        {sections.map((section) => (
          <fieldset key={section.title} disabled={busy} className="min-w-0 border-b border-border px-5 py-6 sm:px-6">
            <legend className="float-left mb-1 w-full text-base font-semibold">{section.title}</legend>
            <p className="clear-both mb-5 text-sm leading-6 text-muted-foreground">{section.description}</p>
            <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">{section.fields.map(field)}</div>
          </fieldset>
        ))}

        <div className="bg-muted/20 px-5 py-4 sm:px-6">
          {state.conflict ? (
            <div role="alert" className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm leading-6">
              <p className="font-medium">Settings changed since you started editing.</p>
              <p className="mt-1 text-muted-foreground">
                Your edits are preserved. Load the latest saved values to replace this draft before editing again.
              </p>
              <Button type="button" variant="outline" className="mt-3" disabled={busy} onClick={onReload}>
                {reloading ? "Loading…" : "Load latest saved values"}
              </Button>
            </div>
          ) : null}
          {state.error ? <p role="alert" className="mb-3 text-sm text-destructive">{state.error}</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p role="status" className="text-sm text-muted-foreground">
              {pending ? "Saving changes…" : reloading ? "Loading saved values…" : state.notice ?? (dirty ? "Unsaved changes" : "No unsaved changes")}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="ghost" disabled={busy} onClick={onDefaults}>
                <RotateCcw aria-hidden="true" /> Recommended defaults
              </Button>
              <Button type="submit" disabled={busy || !dirty || !validation.values || state.conflict}>
                <Save aria-hidden="true" /> {pending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </form>
  );
}
