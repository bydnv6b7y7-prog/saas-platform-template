/**
 * Product commands, so the platform's package.json never names product files:
 *   bun run product <command> [...args]     (from apps/server)
 */
export {};

const commands: Record<string, { run: () => Promise<unknown>; description: string }> = {
  // "import:data": { run: () => import("./import-cli"), description: "load seed data" },
};

const name = process.argv[2];
const command = name ? commands[name] : undefined;
if (!command) {
  console.log(`Usage: bun run product <command> [...args]\n\n${Object.entries(commands).map(([key, { description }]) => `  ${key.padEnd(16)} ${description}`).join("\n") || "  (no product commands yet)"}`);
  process.exit(name ? 1 : 0);
}
// Each command reads its own arguments from process.argv.slice(2).
process.argv.splice(2, 1);
await command.run();
