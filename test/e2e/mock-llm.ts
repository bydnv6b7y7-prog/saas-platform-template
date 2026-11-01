/**
 * A deterministic OpenAI-compatible chat model for end-to-end tests: every reply is
 * "E2E reply: <the last user message>", streamed as Chat Completions chunks.
 */
export function startMockLlm(port: number) {
  let completions = 0;
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
      const body = await request.json() as { stream?: boolean; messages?: { role: string; content: unknown }[] };
      const lastUser = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
      const prompt = typeof lastUser?.content === "string"
        ? lastUser.content
        : Array.isArray(lastUser?.content)
          ? lastUser.content.map((part: { text?: string }) => part.text ?? "").join("")
          : "";
      const reply = `E2E reply: ${prompt.trim().slice(0, 200)}`;
      const base = { id: `chatcmpl-${crypto.randomUUID()}`, created: Math.floor(Date.now() / 1000), model: "e2e-model" };
      const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
      if (!body.stream) {
        return Response.json({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage });
      }
      const chunk = (choices: unknown[], extra: object = {}) => `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices, ...extra })}\n\n`;
      const words = reply.split(/(?<= )/);
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }])));
          for (const word of words) controller.enqueue(encoder.encode(chunk([{ index: 0, delta: { content: word }, finish_reason: null }])));
          controller.enqueue(encoder.encode(chunk([{ index: 0, delta: {}, finish_reason: "stop" }], { usage })));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
    },
  });
  return { stop: () => server.stop(true), completions: () => completions };
}
