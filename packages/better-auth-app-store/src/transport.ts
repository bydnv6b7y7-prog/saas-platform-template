import fetch, { Response, type RequestInit } from "node-fetch";

/** API deadline includes stalled response bodies, not just receipt of response headers. */
export async function appleRequest(url: string, init: RequestInit, throttle: (until: Date) => Promise<void>, deadlineMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, timeout: deadlineMs, redirect: "error", size: 2 * 1024 * 1024 });
    if (response.status === 429) {
      const value = Number(response.headers.get("retry-after"));
      await throttle(new Date(Number.isFinite(value) && value > Date.now() && value <= 8.64e15 ? value : Date.now() + 60_000));
    }
    // Bun can implement node-fetch through its native fetch; enforce the limit here
    // rather than relying on its compatibility layer to honor node-fetch's size option.
    const chunks: Buffer[] = [];
    let size = 0;
    if (response.body) for await (const part of response.body as AsyncIterable<Uint8Array | string>) {
      const chunk = typeof part === "string" ? Buffer.from(part, "utf8") : Buffer.from(part);
      size += chunk.byteLength;
      if (size > 2 * 1024 * 1024) {
        controller.abort();
        throw new Error("Apple API response exceeds 2 MiB");
      }
      chunks.push(chunk);
    }
    return new Response(size ? Buffer.concat(chunks, size) : undefined, { status: response.status, statusText: response.statusText, headers: response.headers });
  } finally { clearTimeout(timer); }
}
