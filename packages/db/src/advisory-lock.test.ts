import { describe, expect, test } from "bun:test";

import { acquireAdvisoryLockConnection } from "./advisory-lock";

function fakeClient(
  query: (
    text: string,
    values: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>,
) {
  const releases: Array<Error | boolean | undefined> = [];
  return {
    client: {
      query,
      release: (error?: Error | boolean) => releases.push(error),
    },
    releases,
  };
}

describe("PostgreSQL advisory lock connection ownership", () => {
  test("destroys the connection when the acquisition query fails", async () => {
    const failure = new Error("connection lost");
    const { client, releases } = fakeClient(async () => {
      throw failure;
    });

    await expect(
      acquireAdvisoryLockConnection(async () => client, 42),
    ).rejects.toBe(failure);
    expect(releases).toEqual([failure]);
  });

  test("returns an unlocked connection to the pool exactly once", async () => {
    const { client, releases } = fakeClient(async () => ({
      rows: [{ pg_try_advisory_lock: false }],
    }));

    expect(await acquireAdvisoryLockConnection(async () => client, 42)).toBeNull();
    expect(releases).toEqual([undefined]);
  });

  test("unlocks and releases an acquired connection exactly once", async () => {
    const queries: string[] = [];
    const { client, releases } = fakeClient(async (text) => {
      queries.push(text);
      return {
        rows: [
          text.includes("pg_try_advisory_lock")
            ? { pg_try_advisory_lock: true }
            : { pg_advisory_unlock: true },
        ],
      };
    });

    const lock = await acquireAdvisoryLockConnection(async () => client, 42);
    expect(lock).not.toBeNull();
    await lock?.release();
    await lock?.release();

    expect(queries).toEqual([
      "SELECT pg_try_advisory_lock($1)",
      "SELECT pg_advisory_unlock($1)",
    ]);
    expect(releases).toEqual([undefined]);
  });

  test("destroys the session when unlock fails", async () => {
    const failure = new Error("unlock failed");
    let queryCount = 0;
    const { client, releases } = fakeClient(async () => {
      queryCount += 1;
      if (queryCount === 2) throw failure;
      return { rows: [{ pg_try_advisory_lock: true }] };
    });

    const lock = await acquireAdvisoryLockConnection(async () => client, 42);
    await expect(lock?.release()).rejects.toBe(failure);
    expect(releases).toEqual([failure]);
  });
});
