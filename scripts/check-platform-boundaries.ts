import { dirname, relative, resolve } from "node:path";

type BoundaryRule = {
  label: string;
  paths: string[];
  allowedWorkspacePackages: ReadonlySet<string>;
};

const workspaceRoot = resolve(import.meta.dir, "..");
const billingManifest = JSON.parse(
  await Bun.file(resolve(workspaceRoot, "packages/billing/package.json")).text(),
) as { name: string };
const workspaceScope = billingManifest.name.slice(0, billingManifest.name.lastIndexOf("/") + 1);
const escapedWorkspaceScope = workspaceScope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const workspaceImportPattern = new RegExp(
  `["']${escapedWorkspaceScope}([^/"']+)(?:/[^"']*)?["']`,
  "g",
);
const rules: BoundaryRule[] = [
  {
    label: "analytics contract",
    paths: ["packages/analytics/src"],
    allowedWorkspacePackages: new Set(["analytics"]),
  },
  {
    label: "billing contract",
    paths: ["packages/billing/src"],
    allowedWorkspacePackages: new Set(["billing"]),
  },
  {
    label: "authentication and billing adapter",
    paths: ["packages/auth/src"],
    allowedWorkspacePackages: new Set(["analytics", "auth", "billing", "db", "env", "better-auth-app-store"]),
  },
  {
    label: "App Store plugin",
    paths: ["packages/better-auth-app-store/src"],
    allowedWorkspacePackages: new Set(["better-auth-app-store"]),
  },
  {
    label: "App Store schema contract",
    paths: ["packages/db/src/schema/iap.ts"],
    allowedWorkspacePackages: new Set(["db", "better-auth-app-store"]),
  },
  {
    label: "platform environment schemas",
    paths: [
      "packages/env/src/platform-server-schema.ts",
      "packages/env/src/platform-web-schema.ts",
    ],
    allowedWorkspacePackages: new Set(["env"]),
  },
  {
    label: "shared UI primitives",
    paths: ["packages/ui/src"],
    allowedWorkspacePackages: new Set(["ui"]),
  },
  {
    label: "authentication schema",
    paths: ["packages/db/src/schema/auth.ts"],
    allowedWorkspacePackages: new Set(["db"]),
  },
];

const violations: string[] = [];

for (const rule of rules) {
  for (const relativePath of await sourceFiles(rule.paths)) {
    const source = await Bun.file(resolve(workspaceRoot, relativePath)).text();
    const imports = source.matchAll(workspaceImportPattern);

    for (const match of imports) {
      const packageName = match[1]!;
      if (!rule.allowedWorkspacePackages.has(packageName)) {
        violations.push(
          `${relativePath}: ${rule.label} cannot depend on ${workspaceScope}${packageName}`,
        );
      }
    }
  }
}

// Product seam: platform code reaches App Store business code only through these entry points,
// so a new product can replace packages/product, apps/*/src/product and every `(product)` route group.
const productSeams = new Set([
  `${workspaceScope}product/router`,
  `${workspaceScope}product/assistant-contracts`,
  "@/product",
  "@/product/assistant",
  "apps/server/src/product",
]);
const isProductPath = (path: string) =>
  path.startsWith("packages/product/") ||
  path.startsWith("apps/server/src/product/") ||
  path.startsWith("apps/web/src/product/") ||
  path.includes("/(product)/") ||
  path.endsWith("routeTree.gen.ts");
const importSpecifierPattern = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const platformRoots = ["apps/server/src", "apps/web/src", ...(await workspacePackageDirs())];

for (const relativePath of await sourceFiles(platformRoots)) {
  if (isProductPath(relativePath)) continue;
  const source = await Bun.file(resolve(workspaceRoot, relativePath)).text();
  for (const match of source.matchAll(importSpecifierPattern)) {
    const specifier = match[1]!;
    const target = specifier.startsWith(".")
      ? relative(workspaceRoot, resolve(workspaceRoot, dirname(relativePath), specifier))
      : specifier;
    const reachesProduct = target === `${workspaceScope}product` || target.startsWith(`${workspaceScope}product/`) ||
      target === "@/product" || target.startsWith("@/product/") || isProductPath(`${target}/`);
    if (!reachesProduct) continue;
    if (relativePath.startsWith("packages/")) {
      violations.push(`${relativePath}: platform packages cannot depend on product code (${specifier})`);
    } else if (!productSeams.has(target.replace(/\/index$/, ""))) {
      violations.push(`${relativePath}: import product code through its seam, not ${specifier}`);
    }
  }
}

if (violations.length > 0) {
  console.error("Platform boundary violations:\n" + violations.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log("Platform boundaries are clean.");

async function sourceFiles(paths: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const path of paths) {
    if (path.endsWith(".ts") || path.endsWith(".tsx")) {
      files.push(path);
      continue;
    }

    const glob = new Bun.Glob("**/*.{ts,tsx}");
    for await (const file of glob.scan({ cwd: resolve(workspaceRoot, path) })) {
      files.push(`${path}/${file}`);
    }
  }
  return files.sort();
}

async function workspacePackageDirs(): Promise<string[]> {
  const dirs: string[] = [];
  for await (const manifest of new Bun.Glob("packages/*/package.json").scan({ cwd: workspaceRoot })) {
    const dir = dirname(manifest);
    if (dir !== "packages/product") dirs.push(dir);
  }
  return dirs.sort();
}
