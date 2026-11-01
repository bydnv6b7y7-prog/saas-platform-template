#!/usr/bin/env bun
/**
 * Every PostgreSQL integration suite, each in a fresh database of its own. CI,
 * the release gate and a laptop run this same list, so none can pass a suite
 * another rejects. Usage: TEST_POSTGRES_URL=postgresql://user:pass@127.0.0.1:5432 bun run test:postgres [name…]
 */
export {};

const SUITES = [
  { name: "iap", file: "packages/db/src/iap.integration.test.ts", variable: "IAP_TEST_DATABASE_URL", database: "iap_test" },
  { name: "email-otp", file: "packages/auth/src/email-otp.postgres.test.ts", variable: "EMAIL_OTP_TEST_DATABASE_URL", database: "email_otp_test" },
  { name: "admin-users", file: "packages/auth/src/admin-users.postgres.test.ts", variable: "ADMIN_USERS_TEST_DATABASE_URL", database: "northwind_admin_users_test" },
  { name: "settings", file: "packages/api/src/operational-settings.integration.test.ts", variable: "OPS_TEST_DATABASE_URL", database: "northwind_config_governance_test" },
  { name: "app-store-admin", file: "packages/api/src/app-store-admin.integration.test.ts", variable: "IAP_ADMIN_TEST_DATABASE_URL", database: "northwind_iap_admin_test" },
  { name: "user-objects", file: "packages/api/src/user-objects.integration.test.ts", variable: "USER_OBJECTS_TEST_DATABASE_URL", database: "northwind_user_objects_test" },
  { name: "app-feedback", file: "apps/server/src/app-client/app-client.integration.test.ts", variable: "APP_FEEDBACK_TEST_DATABASE_URL", database: "northwind_app_feedback_test" },
];

const base = process.env.TEST_POSTGRES_URL;
if (!base) {
  console.error("Set TEST_POSTGRES_URL to a local PostgreSQL the suites may create databases in, e.g. postgresql://postgres:postgres@127.0.0.1:5432");
  process.exit(2);
}
const server = new URL(base);
if (!["127.0.0.1", "localhost"].includes(server.hostname)) {
  console.error("TEST_POSTGRES_URL must be a local server: the suites drop and recreate their databases");
  process.exit(2);
}

const only = process.argv.slice(2);
const selected = only.length ? SUITES.filter((suite) => only.includes(suite.name)) : SUITES;
if (selected.length !== (only.length || SUITES.length)) {
  console.error(`Unknown suite; choose from ${SUITES.map((suite) => suite.name).join(", ")}`);
  process.exit(2);
}

server.pathname = "/postgres";
const admin = new Bun.SQL(server.href);
const failed: string[] = [];
for (const suite of selected) {
  await admin.unsafe(`DROP DATABASE IF EXISTS "${suite.database}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${suite.database}"`);
  const target = new URL(server);
  target.pathname = `/${suite.database}`;
  console.log(`\n▶ ${suite.name}`);
  const child = Bun.spawn(["bun", "test", suite.file], {
    env: { ...process.env, SKIP_ENV_VALIDATION: "1", [suite.variable]: target.href },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await child.exited !== 0) failed.push(suite.name);
}
await admin.close();

if (failed.length) {
  console.error(`\n✗ PostgreSQL suites failed: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`\n✓ ${selected.length} PostgreSQL suites passed`);
