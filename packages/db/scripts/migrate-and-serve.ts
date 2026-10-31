import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createMigrationHealthPayload } from "../src/migration-health";

/**
 * 生产迁移运行器（migration Application 的 command 入口）。
 *
 * 设计目标：迁移结果可观测、CI 门禁语义严格。
 * - 同步执行 db:migrate:production + 分区脚本 + Mastra schema，输出 tee 到 /tmp/migrate.log
 *   （同时透传 stdout 到容器日志）；
 * - 无论成败都启动 :3002 健康服务：成功返回 sha（CI wait_sha 放行依据），
 *   失败返回 status=failed + 日志尾部（操作者可 curl 直接读原因）。
 *
 * 命令必须是单行且不含引号，避免 Dokploy 对 shell 字符串的转义差异
 * （此前 sh -c 内嵌 heredoc/转义引号在 Dokploy 落地时变成 Exited(2)）。
 */

const STATUS_PATH = "/tmp/migrate.status";
const LOG_PATH = "/tmp/migrate.log";
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_DIR = join(DB_DIR, "..", "..", "apps", "server");

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

const result = spawnSync(
  "bash",
  [
    "-lc",
    `set -o pipefail; cd ${DB_DIR} && { bun run db:migrate:production && cd ${SERVER_DIR} && bun run mastra:migrate; } 2>&1 | tee /tmp/migrate.log`,
  ],
  { stdio: "inherit", env: process.env },
);

writeFileSync(STATUS_PATH, result.status === 0 ? "complete" : "failed");
console.log(`[migration] exit=${result.status} status=${read(STATUS_PATH).trim()}`);

Bun.serve({
  port: 3002,
  fetch() {
    const status =
      read(STATUS_PATH).trim() === "complete" ? "complete" : "failed";
    return Response.json(
      createMigrationHealthPayload({
        status,
        buildSha: process.env.BUILD_SHA || "",
        log: read(LOG_PATH),
      }),
    );
  },
});
