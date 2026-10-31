import { describe, expect, it } from "bun:test";
import { normalizeAssistantThreadTitle } from "@northwind/api/assistant";

import {
  createAssistantThreadApp,
  type AssistantThreadMemory,
  type AssistantThreadRouteDeps,
} from "./thread-routes";

const ownThread = {
  id: "thread-own",
  title: "Ranking review",
  resourceId: "user-1",
  createdAt: new Date("2026-08-27T10:00:00.000Z"),
  updatedAt: new Date("2026-08-28T10:00:00.000Z"),
  metadata: { internal: true },
};

function memoryStub(
  overrides: Partial<AssistantThreadMemory> = {},
): AssistantThreadMemory {
  return {
    listThreads: async ({ page, perPage }) => ({
      threads: [ownThread],
      total: 1,
      page,
      perPage,
      hasMore: false,
    }),
    getThreadById: async () => ownThread,
    updateThread: async ({ title }) => ({ ...ownThread, title }),
    deleteThread: async () => undefined,
    ...overrides,
  };
}

function appWith(overrides: Partial<AssistantThreadRouteDeps> = {}) {
  return createAssistantThreadApp({
    getSession: async () => ({ user: { id: "user-1" } }),
    getMemory: async () => memoryStub(),
    deleteReplayHistory: async () => ({
      active: false,
      deletedRunCount: 0,
    }),
    ...overrides,
  });
}

describe("assistant thread routes", () => {
  it("requires authentication", async () => {
    const app = appWith({
      getSession: async () => null,
    });

    const response = await app.request(
      "http://localhost/api/assistant/threads",
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "Sign in to use assistant conversations.",
      },
    });
  });

  it("lists conversations for every signed-in user", async () => {
    let memoryRead = false;
    const app = appWith({
      getMemory: async () => {
        memoryRead = true;
        return memoryStub();
      },
    });

    const response = await app.request("http://localhost/api/assistant/threads");

    expect(response.status).toBe(200);
    expect(memoryRead).toBe(true);
    expect(await response.json()).toMatchObject({
      threads: [{ id: "thread-own" }],
    });
  });

  it("filters by the authenticated resource and sanitizes thread records", async () => {
    let listInput: Parameters<AssistantThreadMemory["listThreads"]>[0] | null =
      null;
    const memory = memoryStub({
      listThreads: async (input) => {
        listInput = input;
        return {
          threads: [ownThread],
          total: 1,
          page: input.page,
          perPage: input.perPage,
          hasMore: false,
        };
      },
    });
    const app = appWith({
      getMemory: async () => memory,
    });

    const response = await app.request(
      "http://localhost/api/assistant/threads?page=1&perPage=20",
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(listInput).toEqual({
      filter: { resourceId: "user-1" },
      orderBy: { field: "updatedAt", direction: "DESC" },
      page: 1,
      perPage: 20,
    });
    expect(body).toEqual({
      threads: [
        {
          id: "thread-own",
          title: "Ranking review",
          createdAt: "2026-08-27T10:00:00.000Z",
          updatedAt: "2026-08-28T10:00:00.000Z",
        },
      ],
      total: 1,
      page: 1,
      perPage: 20,
      hasMore: false,
    });
    expect(JSON.stringify(body)).not.toContain("resourceId");
    expect(JSON.stringify(body)).not.toContain("metadata");
  });

  it("returns 404 instead of exposing a thread owned by another user", async () => {
    let updated = false;
    const app = appWith({
      getMemory: async () =>
        memoryStub({
          getThreadById: async () => ({
            ...ownThread,
            id: "thread-other",
            resourceId: "user-2",
          }),
          updateThread: async (input) => {
            updated = true;
            return { ...ownThread, ...input };
          },
        }),
    });

    const response = await app.request(
      "http://localhost/api/assistant/threads/thread-other",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Do not update" }),
      },
    );

    expect(response.status).toBe(404);
    expect(updated).toBe(false);
  });

  it("validates and updates a title without replacing metadata", async () => {
    let updateInput: Parameters<AssistantThreadMemory["updateThread"]>[0] | null =
      null;
    const app = appWith({
      getMemory: async () =>
        memoryStub({
          updateThread: async (input) => {
            updateInput = input;
            return { ...ownThread, title: input.title };
          },
        }),
    });

    const response = await app.request(
      "http://localhost/api/assistant/threads/thread-own",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "  Finance \n movers  " }),
      },
    );

    expect(response.status).toBe(200);
    expect(updateInput).toEqual({
      id: "thread-own",
      title: "Finance movers",
      metadata: { internal: true },
    });
    expect(await response.json()).toMatchObject({ title: "Finance movers" });
  });

  it("rejects an empty title", async () => {
    let updated = false;
    const app = appWith({
      getMemory: async () =>
        memoryStub({
          updateThread: async (input) => {
            updated = true;
            return { ...ownThread, ...input };
          },
        }),
    });

    const response = await app.request(
      "http://localhost/api/assistant/threads/thread-own",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: " \n\t " }),
      },
    );

    expect(response.status).toBe(400);
    expect(updated).toBe(false);
  });

  it("deletes the owner-scoped replay projection and canonical thread", async () => {
    const operations: string[] = [];
    const app = appWith({
      getMemory: async () =>
        memoryStub({
          getThreadById: async ({ threadId, resourceId }) => {
            operations.push(`lookup:${resourceId}:${threadId}`);
            return ownThread;
          },
          deleteThread: async (threadId) => {
            operations.push(`memory:${threadId}`);
          },
        }),
      deleteReplayHistory: async (userId, threadId) => {
        operations.push(`replay:${userId}:${threadId}`);
        return { active: false, deletedRunCount: 2 };
      },
    });

    const response = await app.request(
      "http://localhost/api/assistant/threads/thread-own",
      { method: "DELETE" },
    );

    expect(response.status).toBe(204);
    expect(operations).toEqual([
      "lookup:user-1:thread-own",
      "replay:user-1:thread-own",
      "memory:thread-own",
    ]);
    expect(await response.text()).toBe("");
  });

  it("does not delete a conversation owned by another user", async () => {
    let replayDeleted = false;
    let memoryDeleted = false;
    const app = appWith({
      getMemory: async () =>
        memoryStub({
          getThreadById: async () => ({
            ...ownThread,
            id: "thread-other",
            resourceId: "user-2",
          }),
          deleteThread: async () => {
            memoryDeleted = true;
          },
        }),
      deleteReplayHistory: async () => {
        replayDeleted = true;
        return { active: false, deletedRunCount: 1 };
      },
    });

    const response = await app.request(
      "http://localhost/api/assistant/threads/thread-other",
      { method: "DELETE" },
    );

    expect(response.status).toBe(404);
    expect(replayDeleted).toBe(false);
    expect(memoryDeleted).toBe(false);
  });

  it("refuses deletion while a run is active", async () => {
    let memoryDeleted = false;
    const app = appWith({
      getMemory: async () =>
        memoryStub({
          deleteThread: async () => {
            memoryDeleted = true;
          },
        }),
      deleteReplayHistory: async () => ({
        active: true,
        deletedRunCount: 0,
      }),
    });

    const response = await app.request(
      "http://localhost/api/assistant/threads/thread-own",
      { method: "DELETE" },
    );

    expect(response.status).toBe(409);
    expect(memoryDeleted).toBe(false);
    expect(await response.json()).toMatchObject({
      error: { code: "thread_running" },
    });
  });

  it("cleans up an owner-scoped orphaned replay history idempotently", async () => {
    const app = appWith({
      getMemory: async () =>
        memoryStub({ getThreadById: async () => null }),
      deleteReplayHistory: async () => ({
        active: false,
        deletedRunCount: 1,
      }),
    });

    const response = await app.request(
      "http://localhost/api/assistant/threads/orphan",
      { method: "DELETE" },
    );

    expect(response.status).toBe(204);
  });

  it("normalizes titles to 64 Unicode characters", () => {
    const title = normalizeAssistantThreadTitle(`Review ${"🧭".repeat(80)}`);

    expect(Array.from(title)).toHaveLength(64);
    expect(title.endsWith("…")).toBe(true);
  });
});
