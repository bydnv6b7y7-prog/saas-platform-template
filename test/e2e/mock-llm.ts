/**
 * A deterministic OpenAI-compatible chat model for end-to-end tests (the same Chat
 * Completions stream DeepSeek and OpenRouter send). By default every reply is
 * "E2E reply: <the last user message>". A rule whose `when` matches the last user
 * message makes the model call a tool instead; once the tool result comes back it
 * answers "E2E tool result: <tool name>".
 */
export type MockModelRule = { when: RegExp; tool: string; arguments: Record<string, unknown> };

type Message = { role: string; content?: unknown; name?: string; tool_call_id?: string };

const text = (content: unknown) => typeof content === "string"
  ? content
  : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : "";

export function startMockLlm(port: number, rules: readonly MockModelRule[] = []) {
  let completions = 0;
  const toolCalls: { tool: string; arguments: Record<string, unknown> }[] = [];
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "e2e-model", object: "model", owned_by: "e2e" }] });
      }
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
      completions++;
      const body = await request.json() as { stream?: boolean; messages?: (Message & { tool_calls?: { id: string; function: { name: string } }[] })[]; tools?: { function: { name: string } }[] };
      const messages = body.messages ?? [];
      const last = messages.at(-1);
      const prompt = text([...messages].reverse().find((message) => message.role === "user")?.content).trim();
      const offered = new Set((body.tools ?? []).map((tool) => tool.function.name));

      let reply: { content: string } | { tool: string; arguments: Record<string, unknown> };
      if (last?.role === "tool") {
        const call = messages.flatMap((message) => message.tool_calls ?? []).find((each) => each.id === last.tool_call_id);
        reply = { content: `E2E tool result: ${call?.function.name ?? last.name ?? "unknown"}` };
      } else {
        const rule = rules.find((candidate) => candidate.when.test(prompt) && offered.has(candidate.tool));
        reply = rule ? { tool: rule.tool, arguments: rule.arguments } : { content: `E2E reply: ${prompt.slice(0, 200)}` };
      }
      if ("tool" in reply) toolCalls.push(reply);

      const base = { id: `chatcmpl-${crypto.randomUUID()}`, created: Math.floor(Date.now() / 1000), model: "e2e-model" };
      const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
      const call = "tool" in reply
        ? { id: `call_${crypto.randomUUID().slice(0, 8)}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.arguments) } }
        : null;
      if (!body.stream) {
        const message = call ? { role: "assistant", content: null, tool_calls: [call] } : { role: "assistant", content: (reply as { content: string }).content };
        return Response.json({ ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: call ? "tool_calls" : "stop" }], usage });
      }
      const chunk = (choices: unknown[], extra: object = {}) => `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices, ...extra })}\n\n`;
      const parts: string[] = [chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }])];
      if (call) {
        // Name first, then the arguments in two pieces, as providers stream them.
        const half = Math.ceil(call.function.arguments.length / 2);
        parts.push(chunk([{ index: 0, delta: { tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } }] }, finish_reason: null }]));
        for (const piece of [call.function.arguments.slice(0, half), call.function.arguments.slice(half)]) {
          parts.push(chunk([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] }, finish_reason: null }]));
        }
        parts.push(chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }], { usage }));
      } else {
        for (const word of (reply as { content: string }).content.split(/(?<= )/)) parts.push(chunk([{ index: 0, delta: { content: word }, finish_reason: null }]));
        parts.push(chunk([{ index: 0, delta: {}, finish_reason: "stop" }], { usage }));
      }
      parts.push("data: [DONE]\n\n");
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(encoder.encode(part));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
    },
  });
  return { stop: () => server.stop(true), completions: () => completions, toolCalls: () => [...toolCalls] };
}
