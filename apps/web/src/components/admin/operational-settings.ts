import type { OperationalSettings } from "@northwind/env/operational-settings";

import type { SettingsSection } from "@/components/admin/settings-form";

export const operationalSettingsSections: SettingsSection<OperationalSettings>[] = [{
  title: "AI usage",
  description: "Limits apply to each account, starting with the next request. Active runs keep their current limits.",
  fields: [
    { key: "assistantFreePer5Minutes", label: "Free · Requests per 5 minutes" },
    { key: "assistantFreePerDay", label: "Free · Requests per UTC day" },
    { key: "assistantProPer5Minutes", label: "Pro · Requests per 5 minutes" },
    { key: "assistantProPerDay", label: "Pro · Requests per UTC day" },
  ],
}];
