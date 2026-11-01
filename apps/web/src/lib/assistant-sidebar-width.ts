export const COPILOT_SIDEBAR_MIN_WIDTH = 360;
export const COPILOT_SIDEBAR_MAX_WIDTH = 520;
export const COPILOT_SIDEBAR_DEFAULT_WIDTH = 420;
const COPILOT_SIDEBAR_WIDTH_STEP = 16;
export const COPILOT_SIDEBAR_STORAGE_KEY =
  "northwind-copilot:sidebar-width";

export function clampCopilotSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return COPILOT_SIDEBAR_DEFAULT_WIDTH;
  return Math.min(
    COPILOT_SIDEBAR_MAX_WIDTH,
    Math.max(COPILOT_SIDEBAR_MIN_WIDTH, Math.round(value)),
  );
}

export function copilotSidebarWidthForKey(
  width: number,
  key: string,
): number | null {
  if (key === "ArrowLeft") {
    return clampCopilotSidebarWidth(width + COPILOT_SIDEBAR_WIDTH_STEP);
  }
  if (key === "ArrowRight") {
    return clampCopilotSidebarWidth(width - COPILOT_SIDEBAR_WIDTH_STEP);
  }
  if (key === "Home") return COPILOT_SIDEBAR_MIN_WIDTH;
  if (key === "End") return COPILOT_SIDEBAR_MAX_WIDTH;
  return null;
}
