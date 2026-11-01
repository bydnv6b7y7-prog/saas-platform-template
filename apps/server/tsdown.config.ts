import { readdirSync } from "node:fs";
import { defineConfig } from "tsdown";

import envManifest from "../../packages/env/package.json" with { type: "json" };

// Workspace packages ship as TypeScript source, so the API bundle always includes them.
const workspaceScope = envManifest.name.slice(0, envManifest.name.indexOf("/") + 1);

// Product background processes (src/product/*-worker.ts) ship as dist/<name>.mjs next to the API.
const workers = Object.fromEntries(
  readdirSync("./src/product")
    .filter((file) => file.endsWith("-worker.ts"))
    .map((file) => [file.slice(0, -".ts".length), `./src/product/${file}`]),
);

export default defineConfig({
  entry: { index: "./src/index.ts", ...workers },
  format: "esm",
  outDir: "./dist",
  clean: true,
  deps: {
    alwaysBundle: [new RegExp(`^${workspaceScope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)],
    onlyBundle: false,
  },
});
