/**
 * Dokploy 应用供给脚本（v0.29.14 API）：
 * 按 .env.dokploy.local 创建/配置 migration + server + web（+ 产品 worker）Application。
 *
 * 运行：bun run deploy:provision
 * 幂等：已存在的项目/应用/域名/端口/挂载跳过重建，只补缺失配置。
 *
 * 流程：
 *   project(找/建 PROJECT) → environment(Production) → postgres(找/建)
 *   → application.create（migration/server/web，产品声明 worker 时再加一个）
 *   → saveDockerProvider（GHCR 镜像 + 凭证）
 *   → saveEnvironment（server 注入运行时 env；web 固定 Bun SSR 监听参数）
 *   → mount（产品声明的共享卷）+ domain × 2（letsencrypt）
 *   → 把 applicationId、数据库密码与生成的 BETTER_AUTH_SECRET 回写 .env.dokploy.local
 *
 * 产品相关的变量、卷与 worker 只来自 packages/product/src/deployment.ts。
 * DEPLOY_STAGE=production|staging 决定 Stripe 密钥必须是 Live 还是 Test；
 * REQUIRED_INTEGRATIONS（默认 email,stripe,posthog）列出缺失即拒绝供给的集成，未列出的缺失时整组不下发。
 */
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import {
  isCopilotModelProvider,
  resolveCopilotModelSelection,
} from "@northwind/env/copilot";
import {
  isPostHogProjectToken,
  POSTHOG_BROWSER_PROXY_HOST,
  POSTHOG_INGESTION_HOST,
} from "@northwind/env/posthog";
import {
  isAnalyticsPrivacyMode,
  parseAnalyticsCountryCodes,
} from "@northwind/env/analytics-privacy";
import { stripeSecretMode } from "@northwind/env/stripe";
import { operationalSettingsEnvSchema } from "@northwind/env/operational-settings";
import { productDeployment } from "@northwind/product/deployment";
import { cloudflareEmailKeys, readCloudflareEmailConfiguration } from "@northwind/env/email";
import { appStoreDeploymentLines } from "@northwind/env/app-store-deployment";
import { mergeEnvLines, parseDeployPolicy, setEnvFileValue } from "./deploy-config";

const ENV_FILE = new URL("../.env.dokploy.local", import.meta.url).pathname;
dotenv.config({ path: ENV_FILE });

/** Dokploy project, application and image name prefix. */
const PROJECT = "northwind";
const BASE = process.env.DOKPLOY_URL;
const KEY = process.env.DOKPLOY_API_KEY;
const NS = process.env.DOCKER_IMAGE_NAMESPACE?.trim();
const REGISTRY_URL = process.env.DOCKER_REGISTRY ?? "ghcr.io";
const REGISTRY_USER = process.env.DOCKER_REGISTRY_USERNAME ?? "";
const REGISTRY_PASS = process.env.DOCKER_REGISTRY_PASSWORD ?? "";
const SERVER_IMAGE = process.env.DOCKER_SERVER_IMAGE_NAME ?? `${PROJECT}-server`;
const WEB_IMAGE = process.env.DOCKER_WEB_IMAGE_NAME ?? `${PROJECT}-web`;
// The release workflow re-pins every application to the SHA it builds; provisioning only needs a valid tag.
const IMAGE_TAG = process.env.DOCKER_IMAGE_TAG?.trim() || (await Bun.$`git rev-parse HEAD`.text()).trim();
const VITE_SERVER_URL = process.env.VITE_SERVER_URL;
const VITE_WEB_URL = process.env.VITE_WEB_URL;
const POLICY = parseDeployPolicy(process.env);
const POSTHOG_PROJECT_TOKEN = process.env.POSTHOG_PROJECT_TOKEN?.trim();
const POSTHOG_HOST = (process.env.POSTHOG_HOST ?? POSTHOG_INGESTION_HOST).trim();
const ANALYTICS_PRIVACY_MODE =
  process.env.ANALYTICS_PRIVACY_MODE?.trim() ?? "geo";
const ANALYTICS_OPT_IN_COUNTRIES =
  process.env.ANALYTICS_OPT_IN_COUNTRIES?.trim();

if (!BASE || !KEY) {
  console.error("缺少 DOKPLOY_URL / DOKPLOY_API_KEY（.env.dokploy.local）");
  process.exit(1);
}
if (!NS || !/^[a-z0-9][a-z0-9._-]*$/.test(NS)) {
  console.error("缺少小写的 DOCKER_IMAGE_NAMESPACE（GHCR 命名空间，通常是 GitHub 用户或组织名）");
  process.exit(1);
}
if (!/^[a-f0-9]{40}$/.test(IMAGE_TAG)) {
  console.error("缺少 40 位 Git SHA：DOCKER_IMAGE_TAG。生产应用不得从 latest 供给。");
  process.exit(1);
}
if (!REGISTRY_USER || !REGISTRY_PASS) {
  console.error("缺少只用于 GHCR 的 DOCKER_REGISTRY_USERNAME / DOCKER_REGISTRY_PASSWORD");
  process.exit(1);
}
const analyticsEnabled = Boolean(POSTHOG_PROJECT_TOKEN) || POLICY.required.has("posthog");
for (const [name, value] of [
  ["VITE_SERVER_URL", VITE_SERVER_URL],
  ["VITE_WEB_URL", VITE_WEB_URL],
  ...(analyticsEnabled ? [["POSTHOG_HOST", POSTHOG_HOST]] as const : []),
] as const) {
  try {
    if (!value || new URL(value).protocol !== "https:") throw new Error();
  } catch {
    console.error(`${name} 必须是显式 HTTPS URL`);
    process.exit(1);
  }
}
if (analyticsEnabled && !isPostHogProjectToken(POSTHOG_PROJECT_TOKEN)) {
  console.error("POSTHOG_PROJECT_TOKEN 必须是有效的 PostHog project token（或从 REQUIRED_INTEGRATIONS 移除 posthog 并留空以关闭分析）");
  process.exit(1);
}
const posthogHostUrl = new URL(POSTHOG_HOST);
if (analyticsEnabled && (
  posthogHostUrl.username ||
  posthogHostUrl.password ||
  posthogHostUrl.pathname !== "/" ||
  posthogHostUrl.search ||
  posthogHostUrl.hash
)) {
  console.error("POSTHOG_HOST 必须是无凭据、路径、查询参数或片段的 HTTPS origin");
  process.exit(1);
}
if (analyticsEnabled && posthogHostUrl.origin === new URL(POSTHOG_BROWSER_PROXY_HOST).origin) {
  console.error("POSTHOG_HOST 是服务端直连地址，不能使用浏览器 Cloudflare proxy");
  process.exit(1);
}
if (!isAnalyticsPrivacyMode(ANALYTICS_PRIVACY_MODE)) {
  console.error("ANALYTICS_PRIVACY_MODE 必须是 geo、opt_in 或 opt_out");
  process.exit(1);
}
try {
  parseAnalyticsCountryCodes(ANALYTICS_OPT_IN_COUNTRIES);
} catch {
  console.error("ANALYTICS_OPT_IN_COUNTRIES 只能包含逗号分隔的两位国家代码");
  process.exit(1);
}
const API_HOST = new URL(VITE_SERVER_URL!).host;
const WEB_HOST = new URL(VITE_WEB_URL!).host;

/** tRPC 调用（Dokploy API key = owner 权限；响应 {result:{data:{json}}}） */
async function api<T = unknown>(path: string, input?: unknown): Promise<T> {
  const doPost = async () => {
    const res = await fetch(`${BASE}/api/trpc/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": KEY!,
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  };
  const doGet = async () => {
    const q =
      input === undefined
        ? ""
        : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
    const res = await fetch(`${BASE}/api/trpc/${path}${q}`, {
      headers: { "x-api-key": KEY! },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  };

  // query 走 GET（?input=），mutation 走 POST；POST 被 405 时自动降级 GET
  let r = await doPost();
  if (!r.ok && (r.status === 405 || /query procedure/i.test(r.text))) {
    r = await doGet();
  }
  if (!r.ok) {
    throw new Error(`API ${path} -> HTTP ${r.status}: ${r.text.slice(0, 400)}`);
  }
  const parsed = JSON.parse(r.text) as {
    result?: { data?: { json?: T } };
    error?: { message?: string };
  };
  if (parsed.error?.message) {
    throw new Error(`API ${path} -> ${parsed.error.message}`);
  }
  return (parsed.result?.data?.json ?? undefined) as T;
}

type ProjectRow = { projectId: string; name: string };
type PostgresSummary = {
  postgresId: string;
  name: string;
};
type PostgresDetail = {
  applicationStatus: string;
  appName: string;
  databaseName: string;
  databaseUser: string;
};
type EnvRow = {
  environmentId: string;
  name: string;
  isDefault?: boolean;
  applications?: AppRow[];
  postgres?: PostgresSummary[];
};
type AppRow = {
  applicationId: string;
  name: string;
  appName: string;
  domains?: Array<{
    domainId: string;
    host: string;
    path?: string | null;
    port?: number | null;
    https?: boolean;
    certificateType?: string;
    domainType?: "application" | "compose" | "preview";
    serviceName?: string | null;
  }>;
  mounts?: Array<{ mountPath: string }>;
  ports?: Array<{ portId: string; publishedPort: number; targetPort: number }>;
};

/** 读取本地开发配置；生产 Stripe 凭据必须来自独立的部署环境文件。 */
function loadServerEnv(): Record<string, string> {
  try {
    const raw = readFileSync(new URL("../apps/server/.env", import.meta.url).pathname, "utf8");
    return dotenv.parse(raw);
  } catch {
    console.log("[provision] 没有 apps/server/.env；只使用 .env.dokploy.local 中的值");
    return {};
  }
}

async function main() {
  // 1) project（找/建；本地模式 serverId 留空，部署在 Settings 内置 server 上）

  const projects = await api<ProjectRow[]>("project.all");
  let project = projects.find((p) => p.name === PROJECT);
  if (!project) {
    await api("project.create", { name: PROJECT, description: `${PROJECT} (${POLICY.stage})` });
    // create 的返回值不含 projectId，回查确认
    project = (await api<ProjectRow[]>("project.all")).find((p) => p.name === PROJECT);
    console.log(`[provision] project 已创建：${PROJECT}`);
  } else {
    console.log("[provision] project 已存在");
  }
  if (!project) throw new Error("project 创建后回查失败");
  const projectId = project.projectId;

  // 2) environment（默认 Production；applications 挂在 environment 下）
  const projectDetail = await api<{ environments?: Array<EnvRow & { isDefault?: boolean; applications?: AppRow[] }> }>(
    "project.one",
    { projectId },
  );
  const environment =
    projectDetail.environments?.find((e) => e.isDefault) ?? projectDetail.environments?.[0];
  if (!environment) throw new Error("project 没有 environment");
  const environmentId = environment.environmentId;
  console.log(`[provision] environment: ${environment.name} (${environmentId})`);

  // 4) 应用规格
  // 2.5) Postgres 数据库服务（找/建；内部连接 host = appName）
  let dbPassword = process.env.DOKPLOY_DB_PASSWORD ?? "";
  const dbName = `${PROJECT}-postgres`;
  let dbConnUrl: string | null = null;
  const postgresList =
    projectDetail.environments?.flatMap((e) => e.postgres ?? []) ?? [];
  let pg = postgresList.find((d) => d.name === dbName);
  if (!pg) {
    const crypto = await import("node:crypto");
    const hadDbPassword = Boolean(dbPassword);
    const password = dbPassword || crypto.randomBytes(16).toString("hex");
    dbPassword = password;
    await api("postgres.create", {
      name: dbName,
      appName: dbName,
      databaseName: PROJECT,
      databaseUser: "app",
      databasePassword: password,
      dockerImage: "postgres:18",
      environmentId,
      description: `${PROJECT} primary database`,
    });
    // 回查确认（create 返回值不含完整行）
    const after = await api<{ environments?: Array<{ postgres?: PostgresSummary[] }> }>(
      "project.one",
      { projectId },
    );
    pg = after.environments?.flatMap((e) => e.postgres ?? []).find((d) => d.name === dbName);
    if (!pg) throw new Error("postgres 创建后回查失败");
    // 回写密码到 .env.dokploy.local，避免重建时换密码
    if (!hadDbPassword) setEnvFileValue(ENV_FILE, "DOKPLOY_DB_PASSWORD", password);
    console.log(`[provision] postgres 已创建：${dbName}（user=app）`);
  } else {
    console.log("[provision] postgres 已存在");
  }
  if (!dbPassword) {
    throw new Error(
      "现有 PostgreSQL 缺少 DOKPLOY_DB_PASSWORD；拒绝用占位密码覆盖应用连接配置",
    );
  }
  // create 不会自动部署；应用侧连接依赖容器在跑。status 非 done 才触发部署
  const pgOne = await api<PostgresDetail>("postgres.one", { postgresId: pg.postgresId });
  if (pgOne.applicationStatus !== "done") {
    await api("postgres.deploy", { postgresId: pg.postgresId, title: "provision: 首部署" });
    console.log("[provision] postgres 已触发部署");
  }
  if (
    !pgOne.appName ||
    !pgOne.databaseName ||
    !pgOne.databaseUser ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(pgOne.appName)
  ) {
    throw new Error("postgres.one 未返回合法的内部连接元数据；拒绝覆盖应用环境");
  }
  // 应用内连接：同机 Docker 网络下 host = 数据库 appName
  const databaseUser = encodeURIComponent(pgOne.databaseUser);
  const databasePassword = encodeURIComponent(dbPassword);
  const databaseName = encodeURIComponent(pgOne.databaseName);
  dbConnUrl =
    `postgresql://${databaseUser}:${databasePassword}` +
    `@${pgOne.appName}:5432/${databaseName}`;

  const localEnv = loadServerEnv();
  // Production values (.env.dokploy.local / process) win over the development profile.
  const deployEnv: Record<string, string | undefined> = { ...localEnv, ...process.env };
  // Preserve current Apple credentials/policy when this production file omits them.
  // Never fill Apple billing credentials from local development or Sandbox profiles.
  const currentApi = environment.applications?.find((application) => application.name === `${PROJECT}-server`);
  const currentApiDetail = currentApi
    ? await api<{ env?: string }>("application.one", { applicationId: currentApi.applicationId })
    : null;
  if (currentApi && typeof currentApiDetail?.env !== "string") {
    throw new Error("application.one 未返回现有 API 环境；拒绝覆盖应用环境以保留 Apple 凭据");
  }
  const appStoreEnvLines = appStoreDeploymentLines(process.env, dotenv.parse(currentApiDetail?.env ?? ""));
  // Deployment-only bootstrap values; never inherit development quotas.
  // Admin database settings take precedence after the first save.
  const operationalEnv = operationalSettingsEnvSchema.parse(process.env);
  const adminUserIdList = (process.env.ADMIN_USER_IDS ?? localEnv.ADMIN_USER_IDS ?? "")
    .split(",")
    .map((userId) => userId.trim())
    .filter(Boolean);
  const adminUserIds = [...new Set(adminUserIdList)].join(",");
  const configuredCopilotProvider = (
    process.env.COPILOT_MODEL_PROVIDER ??
    localEnv.COPILOT_MODEL_PROVIDER ??
    "openai-compatible"
  ).trim();
  const copilotModel = (
    process.env.COPILOT_MODEL ?? localEnv.COPILOT_MODEL ?? ""
  ).trim();
  const deepseekApiKey =
    process.env.DEEPSEEK_API_KEY ?? localEnv.DEEPSEEK_API_KEY ?? "";
  const openrouterApiKey =
    process.env.OPENROUTER_API_KEY ?? localEnv.OPENROUTER_API_KEY ?? "";
  const llmApiKey = process.env.LLM_API_KEY ?? localEnv.LLM_API_KEY ?? "";
  const llmBaseUrl = process.env.LLM_BASE_URL ?? localEnv.LLM_BASE_URL ?? "";
  const llmModel = process.env.LLM_MODEL ?? localEnv.LLM_MODEL ?? "";
  let betterAuthSecret = deployEnv.BETTER_AUTH_SECRET?.trim() ?? "";
  if (!betterAuthSecret) {
    const crypto = await import("node:crypto");
    betterAuthSecret = crypto.randomBytes(32).toString("base64url");
    setEnvFileValue(ENV_FILE, "BETTER_AUTH_SECRET", betterAuthSecret);
    console.log("[provision] 已生成 BETTER_AUTH_SECRET 并写入 .env.dokploy.local");
  }
  if (betterAuthSecret.length < 32 || /[\r\n]/.test(betterAuthSecret)) {
    throw new Error("BETTER_AUTH_SECRET 必须是至少 32 个字符的单行值");
  }
  const stripeBillingKeys = [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_PRO_MONTHLY",
    "STRIPE_PRICE_PRO_YEARLY",
  ] as const;
  const emailConfigured = Boolean(readCloudflareEmailConfiguration(process.env));
  if (!emailConfigured && POLICY.required.has("email")) {
    throw new Error("生产供给缺少 Cloudflare Email 配置（.env.dokploy.local）：CLOUDFLARE_ACCOUNT_ID、CLOUDFLARE_EMAIL_API_TOKEN、EMAIL_FROM");
  }
  const emailEnvLines = emailConfigured
    ? cloudflareEmailKeys.map((key) => `${key}=${JSON.stringify(process.env[key]!.trim())}`)
    : [];
  // iOS app feedback (docs/app-feedback-rating.md): screenshots in R2 — all four or
  // none, otherwise the API refuses to start — and an optional notification address.
  const feedbackStorageKeys = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_ENDPOINT"] as const;
  const presentStorageKeys = feedbackStorageKeys.filter((key) => process.env[key]?.trim());
  if (presentStorageKeys.length > 0 && presentStorageKeys.length < feedbackStorageKeys.length) {
    throw new Error(`生产供给的 R2 配置不完整（.env.dokploy.local）：${feedbackStorageKeys.join("、")} 必须同时设置`);
  }
  const feedbackEnvLines = [
    ...(presentStorageKeys.length > 0
      ? [...feedbackStorageKeys, ...(process.env.R2_REGION?.trim() ? ["R2_REGION"] as const : [])]
        .map((key) => `${key}=${JSON.stringify(process.env[key]!.trim())}`)
      : []),
    ...(process.env.FEEDBACK_NOTIFY_EMAIL?.trim()
      ? [`FEEDBACK_NOTIFY_EMAIL=${JSON.stringify(process.env.FEEDBACK_NOTIFY_EMAIL.trim())}`]
      : []),
  ];
  const productionStripeEnv = Object.fromEntries(
    stripeBillingKeys.map((key) => [key, process.env[key]?.trim() || undefined]),
  ) as Record<(typeof stripeBillingKeys)[number], string | undefined>;
  const missingStripeBillingKeys = stripeBillingKeys.filter(
    (key) => !productionStripeEnv[key],
  );
  const billingEnabled = missingStripeBillingKeys.length < stripeBillingKeys.length || POLICY.required.has("stripe");
  if (billingEnabled && missingStripeBillingKeys.length > 0) {
    throw new Error(
      `生产供给缺少 Stripe billing 配置：${missingStripeBillingKeys.join(", ")}（.env.dokploy.local）`,
    );
  }
  if (billingEnabled) {
    for (const key of stripeBillingKeys) {
      if (/\r|\n/.test(productionStripeEnv[key]!)) {
        throw new Error(`${key} 必须是单行值`);
      }
    }
    const expectedMode = POLICY.stage === "production" ? "live" : "test";
    if (stripeSecretMode(productionStripeEnv.STRIPE_SECRET_KEY!) !== expectedMode) {
      throw new Error(
        `DEPLOY_STAGE=${POLICY.stage} 只接受 ${expectedMode === "live" ? "Live" : "Test"} 模式的 Stripe 密钥`,
      );
    }
    if (!productionStripeEnv.STRIPE_WEBHOOK_SECRET!.startsWith("whsec_")) {
      throw new Error("STRIPE_WEBHOOK_SECRET 必须是 endpoint signing secret");
    }
    for (const key of [
      "STRIPE_PRICE_PRO_MONTHLY",
      "STRIPE_PRICE_PRO_YEARLY",
    ] as const) {
      if (!productionStripeEnv[key]!.startsWith("price_")) {
        throw new Error(`${key} 必须是 Stripe Price ID`);
      }
    }
  }
  const oauthProviderGroups = [
    {
      name: "Google",
      keys: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
      optionalKeys: ["GOOGLE_IOS_CLIENT_ID"],
    },
    {
      name: "GitHub",
      keys: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
      optionalKeys: [],
    },
    {
      name: "Apple",
      keys: [
        "APPLE_CLIENT_ID",
        "APPLE_TEAM_ID",
        "APPLE_KEY_ID",
        "APPLE_PRIVATE_KEY_BASE64",
      ],
      optionalKeys: [],
    },
  ] as const;
  for (const provider of oauthProviderGroups) {
    const configuredKeys = provider.keys.filter((key) => Boolean(deployEnv[key]));
    if (configuredKeys.length > 0 && configuredKeys.length < provider.keys.length) {
      const missingKeys = provider.keys.filter((key) => !deployEnv[key]);
      throw new Error(
        `${provider.name} OAuth 配置不完整，缺少 ${missingKeys.join(", ")}（.env.dokploy.local 或 apps/server/.env）`,
      );
    }
    for (const key of [...configuredKeys, ...provider.optionalKeys.filter((key) => Boolean(deployEnv[key]))]) {
      if (/[\r\n]/.test(deployEnv[key]!)) {
        throw new Error(`${key} 必须是单行环境变量`);
      }
    }
  }
  if (adminUserIdList.some((userId) => /[=\r\n]/.test(userId))) {
    throw new Error("ADMIN_USER_IDS 包含非法的环境变量控制字符");
  }
  if (!isCopilotModelProvider(configuredCopilotProvider)) {
    throw new Error(
      "生产供给的 COPILOT_MODEL_PROVIDER 必须是 openai-compatible、deepseek 或 openrouter",
    );
  }
  const copilotModelProvider = configuredCopilotProvider;
  for (const [name, value] of [
    ["COPILOT_MODEL", copilotModel],
    ["DEEPSEEK_API_KEY", deepseekApiKey],
    ["OPENROUTER_API_KEY", openrouterApiKey],
    ["LLM_API_KEY", llmApiKey],
    ["LLM_BASE_URL", llmBaseUrl],
    ["LLM_MODEL", llmModel],
  ] as const) {
    if (/[\r\n]/.test(value)) throw new Error(`${name} 必须是单行环境变量`);
  }
  const copilotModelSelection = resolveCopilotModelSelection({
    provider: copilotModelProvider,
    model: copilotModel,
    deepseekApiKey,
    openrouterApiKey,
    llmApiKey,
    llmBaseUrl,
    llmModel,
  });
  if (!copilotModelSelection.configured) {
    if (copilotModelProvider === "deepseek") {
      throw new Error("选择 DeepSeek Copilot 时必须配置 DEEPSEEK_API_KEY");
    }
    if (copilotModelProvider === "openrouter") {
      throw new Error("选择 OpenRouter Copilot 时必须配置 OPENROUTER_API_KEY");
    }
    if (!llmApiKey.trim()) {
      throw new Error("选择 OpenAI-compatible Copilot 时必须配置 LLM_API_KEY");
    }
    throw new Error("自定义 LLM_BASE_URL 时必须配置 COPILOT_MODEL 或 LLM_MODEL");
  }
  const serverEnvLines = [
    `DATABASE_URL=${dbConnUrl}`,
    `BETTER_AUTH_SECRET=${betterAuthSecret}`,
    `BETTER_AUTH_URL=${VITE_SERVER_URL}`,
    `CORS_ORIGIN=${VITE_WEB_URL}`,
    `ADMIN_USER_IDS=${adminUserIds}`,
    `LOG_LEVEL=${localEnv.LOG_LEVEL || "info"}`,
    `HTTP_LOG_SAMPLE_RATE=${localEnv.HTTP_LOG_SAMPLE_RATE || "0.1"}`,
    `HTTP_SLOW_REQUEST_MS=${localEnv.HTTP_SLOW_REQUEST_MS || "1000"}`,
    `MASTRA_TRACE_RETENTION_DAYS=${localEnv.MASTRA_TRACE_RETENTION_DAYS || "14"}`,
    `ASSISTANT_CONTEXT_TOKEN_LIMIT=${localEnv.ASSISTANT_CONTEXT_TOKEN_LIMIT || "32000"}`,
    ...Object.entries(operationalEnv).map(([key, value]) => `${key}=${value}`),
    ...(localEnv.METRICS_TOKEN ? [`METRICS_TOKEN=${localEnv.METRICS_TOKEN}`] : []),
    ...productDeployment.serverEnv(process.env, localEnv),
  ];
  // External AI credentials belong only in the API process.
  const externalAiEnvLines = [
    ...productDeployment.apiEnv(process.env, localEnv),
    ...(llmApiKey ? [`LLM_API_KEY=${llmApiKey}`] : []),
    ...(llmBaseUrl ? [`LLM_BASE_URL=${llmBaseUrl}`] : []),
    ...(llmModel ? [`LLM_MODEL=${llmModel}`] : []),
  ];
  const copilotEnvLines = [
    `COPILOT_MODEL_PROVIDER=${copilotModelProvider}`,
    ...(copilotModel ? [`COPILOT_MODEL=${copilotModel}`] : []),
    ...(copilotModelProvider === "deepseek" && deepseekApiKey
      ? [`DEEPSEEK_API_KEY=${deepseekApiKey}`]
      : []),
    ...(copilotModelProvider === "openrouter" && openrouterApiKey
      ? [`OPENROUTER_API_KEY=${openrouterApiKey}`]
      : []),
  ];
  const oauthEnvLines = oauthProviderGroups.flatMap((provider) =>
    provider.keys.every((key) => Boolean(deployEnv[key]))
      ? [...provider.keys, ...provider.optionalKeys.filter((key) => Boolean(deployEnv[key]))]
          .map((key) => `${key}=${deployEnv[key]}`)
      : [],
  );
  const stripeBillingEnvLines = billingEnabled
    ? stripeBillingKeys.map((key) => `${key}=${productionStripeEnv[key]}`)
    : [];
  const posthogEnvLines = analyticsEnabled
    ? [`POSTHOG_PROJECT_TOKEN=${POSTHOG_PROJECT_TOKEN}`, `POSTHOG_HOST=${posthogHostUrl.origin}`]
    : [];
  const productMount = productDeployment.volume
    ? { volumeName: `${PROJECT}-${productDeployment.volume.name}`, mountPath: productDeployment.volume.mountPath }
    : undefined;
  const worker = productDeployment.worker;
  const apps: Array<{
    role: "migration" | "server" | "web" | "worker";
    name: string;
    image: string;
    env: string;
    domain?: { host: string; port: number; path?: string };
    port?: { publishedPort: number; targetPort: number };
    mount?: { volumeName: string; mountPath: string };
    command?: string;
  }> = [
    {
      role: "migration",
      name: `${PROJECT}-migration`,
      image: `${REGISTRY_URL}/${NS}/${SERVER_IMAGE}:${IMAGE_TAG}`,
      env: [...serverEnvLines, "APP_PROCESS_NAME=migration"].join("\n"),
      // 单行、无引号：迁移与健康服务封装在镜像内的 migrate-and-serve.ts，
      // 避免 Dokploy 对复杂 shell 字符串的转义差异（此前出现 Exited(2)）。
      command: "bun /app/packages/db/scripts/migrate-and-serve.ts",
      domain: { host: API_HOST, port: 3002, path: "/internal/migration-ready" },
    },
    {
      role: "server",
      name: `${PROJECT}-server`,
      image: `${REGISTRY_URL}/${NS}/${SERVER_IMAGE}:${IMAGE_TAG}`,
      env: [
        ...serverEnvLines,
        ...externalAiEnvLines,
        ...copilotEnvLines,
        ...oauthEnvLines,
        ...emailEnvLines,
        ...feedbackEnvLines,
        ...stripeBillingEnvLines,
        ...appStoreEnvLines,
        ...posthogEnvLines,
        "APP_PROCESS_NAME=api",
      ].join("\n"),
      domain: { host: API_HOST, port: 3000 },
      port: { publishedPort: 3000, targetPort: 3000 },
      mount: productMount,
    },
    {
      role: "web",
      name: `${PROJECT}-web`,
      image: `${REGISTRY_URL}/${NS}/${WEB_IMAGE}:${IMAGE_TAG}`,
      env: [
        "HOST=0.0.0.0",
        "PORT=3001",
        "NODE_ENV=production",
        `ANALYTICS_PRIVACY_MODE=${ANALYTICS_PRIVACY_MODE}`,
        ...(ANALYTICS_OPT_IN_COUNTRIES
          ? [`ANALYTICS_OPT_IN_COUNTRIES=${ANALYTICS_OPT_IN_COUNTRIES}`]
          : []),
      ].join("\n"),
      domain: { host: WEB_HOST, port: 3001 },
    },
    ...(worker ? [{
      role: "worker" as const,
      name: `${PROJECT}-${worker.name}`,
      image: `${REGISTRY_URL}/${NS}/${SERVER_IMAGE}:${IMAGE_TAG}`,
      env: mergeEnvLines(serverEnvLines, [...worker.env, "APP_PROCESS_NAME=worker"]).join("\n"),
      command: worker.command,
      mount: productMount,
    }] : []),
  ];

  const existingApps = environment.applications ?? [];
  const results: Record<string, string> = {};

  for (const spec of apps) {
    // 4a) 找/建应用
    let app = existingApps.find((a) => a.name === spec.name);
    let applicationId = app?.applicationId;
    if (!applicationId) {
      const created = await api<{ applicationId: string }>("application.create", {
        name: spec.name,
        appName: spec.name.replaceAll("-", "").slice(0, 30),
        description: spec.name,
        environmentId,
      });
      applicationId = created.applicationId;
      console.log(`[provision] application 已创建：${spec.name} (${applicationId})`);
    } else {
      console.log(`[provision] application 已存在：${spec.name} (${applicationId})`);
    }
    results[spec.role] = applicationId;

    // 4b) Docker provider（GHCR 镜像 + 凭证）
    await api("application.saveDockerProvider", {
      applicationId,
      dockerImage: spec.image,
      username: REGISTRY_USER,
      password: REGISTRY_PASS,
      registryUrl: REGISTRY_URL,
    });

    // 4c) command 覆盖（migration / worker）
    if (spec.command) {
      await api("application.update", { applicationId, command: spec.command });
    }

    // 4d) 环境变量
    await api("application.saveEnvironment", {
      applicationId,
      env: spec.env,
      buildArgs: "",
      buildSecrets: "",
      createEnvFile: false,
    });

    // 4d) 域名（https + letsencrypt）
    const detail = await api<AppRow>("application.one", { applicationId });
    const domainPath = spec.domain?.path ?? "/";
    const existingDomain = spec.domain
      ? detail.domains?.find(
          (domain) =>
            domain.host === spec.domain!.host && (domain.path ?? "/") === domainPath,
        )
      : undefined;
    if (spec.domain && !existingDomain) {
      await api("domain.create", {
        host: spec.domain!.host,
        path: domainPath,
        port: spec.domain!.port,
        https: true,
        certificateType: "letsencrypt",
        applicationId,
      });
      console.log(`[provision] domain 已建：${spec.domain!.host} → ${spec.name}:${spec.domain!.port}`);
    } else if (
      spec.domain &&
      existingDomain &&
      existingDomain.port !== spec.domain.port
    ) {
      await api("domain.update", {
        domainId: existingDomain.domainId,
        host: existingDomain.host,
        path: existingDomain.path ?? domainPath,
        port: spec.domain.port,
        https: existingDomain.https ?? true,
        certificateType: existingDomain.certificateType ?? "letsencrypt",
        domainType: existingDomain.domainType ?? "application",
        ...(existingDomain.serviceName
          ? { serviceName: existingDomain.serviceName }
          : {}),
      });
      console.log(
        `[provision] domain 端口已修正：${spec.domain.host} ${existingDomain.port ?? "unset"} → ${spec.domain.port}`,
      );
    } else if (spec.domain && existingDomain) {
      console.log(
        `[provision] domain 已就绪：${spec.domain.host} → ${spec.name}:${spec.domain.port}`,
      );
    }

    // 4e) 制品卷（不再发布 host 端口：共享主机 3000 易冲突，traefik 域名路由直达；
    //     2026-08-17 实测同机其他项目占用 3000 导致 server 容器起不来）
    if (spec.port && detail.ports?.some((p) => p.publishedPort === spec.port!.publishedPort)) {
      const portId = detail.ports.find((p) => p.publishedPort === spec.port!.publishedPort)!.portId;
      await api("port.delete", { portId });
      console.log("[provision] 已移除冲突的 host 端口发布");
    }
    if (spec.mount && !detail.mounts?.some((m) => m.mountPath === spec.mount!.mountPath)) {
      await api("mounts.create", {
        serviceId: applicationId,
        serviceType: "application",
        type: "volume",
        volumeName: spec.mount.volumeName,
        mountPath: spec.mount.mountPath,
      });
      console.log(`[provision] volume 已挂载：${spec.mount.mountPath}`);
    }
  }

  // 5) 回写 applicationId（deploy:github 同步到 GitHub Secrets）
  for (const role of ["migration", "server", "web", "worker"] as const) {
    if (results[role]) setEnvFileValue(ENV_FILE, `DOKPLOY_${role.toUpperCase()}_APPLICATION_ID`, results[role]);
  }

  console.log("\n[provision] 完成：");
  console.log(`  migrate: ${results.migration}`);
  console.log(`  server:  ${results.server} → ${VITE_SERVER_URL}`);
  console.log(`  web:     ${results.web} → ${VITE_WEB_URL}`);
  if (results.worker) console.log(`  worker:  ${results.worker}`);
  console.log(`✅ 拓扑已就绪（${POLICY.stage}）：postgres + migration + server(API) + web${results.worker ? " + worker" : ""}；`);
  console.log("   发布顺序由 workflow 固定为 migration → server → web → worker。下一步：bun run deploy:github");
}

main().catch((err) => {
  console.error("[provision] 失败：", err instanceof Error ? err.message : err);
  process.exit(1);
});
