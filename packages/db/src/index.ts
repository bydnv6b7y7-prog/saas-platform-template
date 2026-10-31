import { env } from "@northwind/env/server";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { acquireAdvisoryLockConnection } from "./advisory-lock";
import * as schema from "./schema";

// One ESM singleton means one pool per API or worker process. Auth, tRPC, raw SQL,
// advisory locks, readiness, Mastra and the Intelligence Module all share this pool.
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 12,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  allowExitOnIdle: false,
  application_name: process.env.APP_PROCESS_NAME ?? "northwind-api",
});

export const db = drizzle({ client: pool, schema });

// 供 apps/server 采集器等使用方直接复用，避免各自安装 drizzle-orm 造成版本漂移
export {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";

/**
 * 参数化原始查询：drizzle execute 不接受参数数组，
 * 这里直接用 pg 连接池执行带 $n 占位符的 SQL。
 */
export async function rawQuery<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<{ rows: T[] }> {
  const result = await pool.query(text, params);
  return { rows: result.rows as T[] };
}

export async function checkDb(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function closeDb(): Promise<void> {
  await pool.end();
}

/**
 * PG advisory lock（跨进程互斥）：采集轮/一次性任务用，防止 CLI 与
 * 调度器（或多实例部署）并发执行同一轮。锁与同一连接绑定，用完必须 release。
 */
export async function acquireAdvisoryLock(
  key: number,
): Promise<{ release: () => Promise<void> } | null> {
  return acquireAdvisoryLockConnection(() => pool.connect(), key);
}

/**
 * 有界等待的 advisory lock（采集轮用）：滚动部署/手工 CLI 与调度轮重叠时，
 * 瞬时冲突不应让整个 3h 周期作废——每 pollMs 重试，直到 timeoutMs 或拿到锁。
 */
export async function acquireAdvisoryLockWithTimeout(
  key: number,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ release: () => Promise<void> } | null> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const pollMs = opts.pollMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lock = await acquireAdvisoryLock(key);
    if (lock) return lock;
    if (Date.now() + pollMs > deadline) return null;
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
}
