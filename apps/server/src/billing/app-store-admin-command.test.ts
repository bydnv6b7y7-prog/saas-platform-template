import { expect, test } from "bun:test";
import { parseAppStoreAdminCommand as parse } from "../app-store-admin-command";

test("read-only lookup requires one exact selector and an auditable operator", () => {
  expect(parse(["show", "--operator", "admin", "--user-id", "alice"]).command).toBe("show");
  for (const args of [
    ["show", "--user-id", "alice"],
    ["show", "--operator", "admin"],
    ["show", "--operator", "admin", "--user-id", "alice", "--transaction-id", "1"],
    ["show", "--operator", "admin", "--transaction-id", "1;drop"],
    ["show", "--operator", "admin", "--token", "prefix-only"],
    ["show", "--operator", "admin", "--user-id", "alice", "--to-user-id", "bob"],
  ]) expect(() => parse(args)).toThrow();
});
test("mutating commands require explicit intent and supported environments", () => {
  const transfer = ["transfer", "--operator", "admin", "--transaction-id", "1", "--to-user-id", "bob", "--reason", "Support ticket #123"];
  expect(() => parse(transfer)).toThrow();
  expect(parse([...transfer, "--confirm"]).command).toBe("transfer");
  expect(() => parse([...transfer, "--confirm", "--env", "LocalTesting"])).toThrow();
  expect(() => parse(["test-notification", "--operator", "admin"])).toThrow();
  expect(parse(["test-notification", "--operator", "admin", "--env", "Sandbox", "--confirm"]).values.env).toBe("Sandbox");
});
