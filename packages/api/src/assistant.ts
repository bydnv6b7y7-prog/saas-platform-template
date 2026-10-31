/** Product-independent assistant helpers shared by the server thread API and the web sidecar. */
export function normalizeAssistantThreadTitle(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  if (characters.length <= 64) return normalized;
  return `${characters.slice(0, 63).join("")}…`;
}
