import { useLocation } from "@tanstack/react-router";
import { LoaderCircle, Sparkles } from "lucide-react";
import { useMemo } from "react";

import { assistantPageContextLabel, buildAssistantPageContext } from "@/product";

export type AssistantAccess = "loading" | "available" | "unavailable";

export function AssistantOrb({
  access,
  open,
  onToggle,
}: {
  access: AssistantAccess;
  open: boolean;
  onToggle: () => void;
}) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const search = useLocation({
    select: (location) => location.search as Record<string, unknown>,
  });
  const context = useMemo(
    () => buildAssistantPageContext(pathname, search),
    [pathname, search],
  );

  if (access === "unavailable") return null;

  const contextLabel = assistantPageContextLabel(context);
  const label =
    access === "loading"
      ? "Checking Northwind AI availability"
      : `Ask Northwind AI about ${contextLabel}`;

  return (
    <div
      inert={open}
      className="assistant-orb-wrap"
      data-open={open ? "true" : "false"}
    >
      <span className="assistant-orb-label" aria-hidden="true">
        <span>Northwind AI</span>
        <span>{contextLabel}</span>
      </span>
      <button
        type="button"
        data-assistant-trigger={access === "available" ? "true" : undefined}
        aria-label={label}
        aria-controls={access === "available" ? "northwind-copilot-sidebar" : undefined}
        aria-expanded={access === "available" ? open : undefined}
        title={label}
        disabled={access !== "available"}
        onClick={onToggle}
        className="assistant-orb"
      >
        {access === "loading" ? (
          <LoaderCircle className="assistant-spinner size-5" aria-hidden="true" />
        ) : (
          <Sparkles className="size-5" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
