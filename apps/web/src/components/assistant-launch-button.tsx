import { Button } from "@northwind/ui/components/button";
import { Sparkles } from "lucide-react";

import { useOptionalAssistantSurface } from "@/components/app-shell";

export function AssistantLaunchButton({
  label = "Ask AI",
  size = "sm",
}: {
  label?: string;
  size?: "sm" | "default";
}) {
  const surface = useOptionalAssistantSurface();
  if (!surface) return null;

  const { access, open, openAssistant } = surface;
  if (access === "unavailable") return null;

  return (
    <Button
      type="button"
      size={size}
      variant="outline"
      data-assistant-trigger={access === "available" ? "true" : undefined}
      aria-controls={
        access === "available" ? "northwind-copilot-sidebar" : undefined
      }
      aria-expanded={access === "available" ? open : undefined}
      disabled={access !== "available"}
      onClick={openAssistant}
      data-icon="inline-start"
    >
      <Sparkles aria-hidden="true" />
      {open ? "AI open" : label}
    </Button>
  );
}
