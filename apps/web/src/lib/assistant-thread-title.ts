import { normalizeAssistantThreadTitle as normalizeTitle } from "@northwind/api/assistant";

function textFromMessage(
  message: unknown,
  role: "assistant" | "user",
): string | null {
  if (!message || typeof message !== "object") return null;
  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== role) return null;
  if (typeof candidate.content === "string") return candidate.content;
  if (!Array.isArray(candidate.content)) return null;
  const text = candidate.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string"
        ? value.text
        : "";
    })
    .join(" ");
  return text || null;
}

export function hasAssistantText(messages: readonly unknown[]): boolean {
  return messages.some((message) =>
    Boolean(textFromMessage(message, "assistant")?.trim()),
  );
}

export function normalizeAssistantThreadTitle(
  messages: readonly unknown[],
): string | null {
  const content = messages
    .map((message) => textFromMessage(message, "user"))
    .find((value): value is string => Boolean(value?.trim()));
  return content ? normalizeTitle(content) : null;
}
