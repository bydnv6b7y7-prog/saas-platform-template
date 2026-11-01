import { parseArgs } from "node:util";
import { environment, normalizeToken, transactionId } from "@northwind/better-auth-app-store/core";

const userID = (value: string | undefined) => {
  if (!value || value.length > 128 || /\s/.test(value)) throw new Error("A valid user ID is required");
  return value;
};
export function parseAppStoreAdminCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    "transaction-id": { type: "string" }, "user-id": { type: "string" }, token: { type: "string" },
    env: { type: "string", default: "Production" }, "to-user-id": { type: "string" },
    "from-user-id": { type: "string" }, operator: { type: "string" }, reason: { type: "string" }, confirm: { type: "boolean", default: false },
  } });
  const command = positionals[0];
  if (positionals.length !== 1 || !["show", "transfer", "test-notification"].includes(command ?? "")) throw new Error("Usage: admin:app-store show|transfer|test-notification --operator <adminUserId> [options]");
  userID(values.operator);
  environment(values.env, ["Production", "Sandbox"]);
  if (values["transaction-id"]) transactionId(values["transaction-id"]);
  if (values["user-id"]) userID(values["user-id"]);
  if (values["to-user-id"]) userID(values["to-user-id"]);
  if (values["from-user-id"]) userID(values["from-user-id"]);
  if (values.token) normalizeToken(values.token);
  const selectors = [values["transaction-id"], values["user-id"], values.token].filter(Boolean);
  if (command === "test-notification") {
    if (!values.confirm || selectors.length) throw new Error("Test notification requires --confirm and no subscription selector");
  } else if (selectors.length !== 1) throw new Error("Specify exactly one of --transaction-id, --user-id, --token");
  if (command === "transfer") {
    if (!values.confirm || !values["transaction-id"] || !values["to-user-id"] || !values.reason?.trim() || values.reason.length > 1000) throw new Error("Transfer requires --confirm, --transaction-id, --to-user-id and a reason");
  } else if (values["to-user-id"] || values["from-user-id"] || values.reason) throw new Error("Transfer arguments require the transfer command");
  return { command: command as "show" | "transfer" | "test-notification", values };
}
