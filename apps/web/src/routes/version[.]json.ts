import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

function buildSha(): string {
  return (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env?.BUILD_SHA ?? "development";
}

export const Route = createFileRoute("/version.json")({
  server: {
    handlers: {
      GET: () =>
        Response.json(
          { sha: buildSha() },
          {
            headers: {
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          },
        ),
    },
  },
});
