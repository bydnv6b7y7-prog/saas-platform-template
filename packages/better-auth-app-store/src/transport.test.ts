import { expect, test } from "bun:test";
import { appleRequest } from "./transport";

test("real HTTP transport interprets Retry-After as an absolute millisecond timestamp", async () => {
  const until = Date.now() + 60_000;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ errorCode: 4290000 }, { status: 429, headers: { "retry-after": String(until) } }) });
  try {
    let saved: Date | undefined;
    const result = await appleRequest(server.url.toString(), {}, async value => { saved = value; });
    expect(saved!.getTime()).toBe(until); expect(result.status).toBe(429);
    expect(await result.json()).toEqual({ errorCode: 4290000 });
  } finally { await server.stop(true); }
});
test("real HTTP transport aborts a stalled body after receiving headers", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("partial")); } })) });
  try {
    const start = Date.now();
    await expect(appleRequest(server.url.toString(), {}, async () => {}, 60)).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - start).toBeLessThan(2000);
  } finally { await server.stop(true); }
});
test("real HTTP transport refuses redirects and response bodies larger than 2 MiB", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/redirect"
    ? new Response(null, { status: 302, headers: { location: "/large" } }) : new Response(new Uint8Array(2 * 1024 * 1024 + 1)) });
  try {
    await expect(appleRequest(new URL("/redirect", server.url).toString(), {}, async () => {})).rejects.toThrow();
    await expect(appleRequest(new URL("/large", server.url).toString(), {}, async () => {})).rejects.toThrow("2 MiB");
  } finally { await server.stop(true); }
});
test("empty successful API responses remain valid", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 204 }) });
  try {
    const response = await appleRequest(server.url.toString(), {}, async () => {});
    expect(response.status).toBe(204); expect(await response.text()).toBe("");
  } finally { await server.stop(true); }
});
