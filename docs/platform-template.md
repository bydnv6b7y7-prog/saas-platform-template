# 平台模板：基础能力与业务代码的边界

> 状态：Current · 2026-10-31
> 原则：业务代码只放在四个固定位置；平台代码只经由入口文件触达业务。模板由脚本从本仓库导出，不手工维护副本。

## 1. 平台提供什么

| 能力 | 位置 |
| --- | --- |
| 账号：邮箱密码 + OTP 验证、Google / GitHub / Apple 登录、iOS 原生登录、账号删除 | `packages/auth`、`apps/web/src/routes/login.tsx`、`_auth/` |
| 支付：Stripe Checkout / Portal 订阅、App Store 内购订阅（`better-auth-app-store`） | `packages/auth`、`packages/billing`、`packages/better-auth-app-store` |
| 对象存储：Cloudflare R2（S3 API）反馈截图与保留期清理 | `packages/api/src/feedback-screenshots.ts`、`apps/server/src/app-client` |
| Agent 运行骨架：Mastra 存储/记忆/观测、耐久化 AG-UI run、线程 API、CopilotKit 侧栏、按套餐限额 | `apps/server/src/mastra`、`apps/web/src/components/copilot` |
| Admin：用户与角色、运行配置、App Store 诊断、客户端配置、反馈收件箱 | `packages/api`、`apps/web/src/routes/admin` |
| 分析：PostHog、区域化同意、身份拼接、服务端转化事件 | `packages/analytics`、`apps/web/src/lib/analytics*.ts` |
| 运维：镜像、迁移优先启动、`/livez` `/readyz` `/internal/metrics`、加密备份 | `apps/*/Dockerfile`、`docker-compose.yml`、`scripts/` |

## 2. 业务代码在哪里

| 位置 | 内容 | 平台经由的入口（契约） |
| --- | --- | --- |
| `packages/product` | 业务 schema、tRPC 路由、业务 env（`productEnv`）、Market AI 开关中间件、助手工具契约 | `router.ts`（组合 `appRouter`）、`assistant-contracts.ts`（`ASSISTANT_AGENT_ID`、`ASSISTANT_PAGE_TOOL_NAMES`、`AssistantPageContext`）；`db:post-migrate` 脚本 |
| `apps/server/src/product` | 采集、CLI、worker、App Store Agent 的工具/技能/指令 | `index.ts`：`assistantAgents`、`serverProduct`（服务名、就绪表、状态、指标、后台 worker） |
| `apps/web/src/product` | 榜单/市场/Finding 组件、App SEO、站点地图、助手页面上下文与工具渲染 | `index.ts`（导航、首页、Admin 页签与设置、页脚、SEO、定价文案、登录页文案、站点地图）、`assistant/index.tsx`（页面上下文 hook、页面工具、渲染器、欢迎卡片） |
| `apps/web/src/routes/**/(product)/` | 业务页面与法律页（每个产品的隐私/条款不同） | 需登录页面放 `routes/_auth/(product)/`，管理页放 `routes/admin/(product)/`，以继承父布局守卫 |

依赖只能由外向内：

```text
业务（上表四处） ──► 平台入口契约 ◄── 平台（apps 外壳、packages/*）
                 └──────────► 平台包（auth/billing/api/db/env/ui …）
```

`bun run check:boundaries`（`check-types` 的第一步）强制：平台包不得引用任何业务代码；`apps/*` 的平台代码只能 import
`@northwind/product/{router,assistant-contracts}`、`@/product`、`@/product/assistant` 和 `apps/server/src/product`（入口）。

数据库：平台表在 `packages/db/src/schema`，业务表在 `packages/product/src/schema`，`drizzle.config.ts` 同时读取两处；
本仓库的迁移历史仍是单一序列（`packages/db/src/migrations`）。`packages/db` 的 `db:migrate` 结束后调用业务的
`db:post-migrate`（本产品用于维护榜单快照分区）。

## 3. 导出模板

```bash
bun run template:export -- ../my-template --scope @acme --brand Acme
bun run template:check   # CI 同款：导出到 .template-check 并跑 check-types + test
```

导出脚本（`scripts/export-template.ts`）：

1. 复制 `git ls-files` 中的平台文件，跳过上表四处业务位置、`docs/`、`infra/`、本仓库专属的发布脚本
   （`deploy.yml`、Dokploy、`api-smoke.sh`、`deploy-production.sh`）和 IAP 开发隧道；
2. 用 `template/starter/` 覆盖业务位置：首页、`example.hello` 路由、无工具的助手、占位隐私/条款与 README；
3. 替换 workspace scope、品牌名（`Northwind` → `--brand`）和品牌资源文件名，移除 compose 中的采集 worker 与业务变量；
4. `git init`、`bun install`，用 drizzle-kit 生成仅含平台表的基线迁移，并附上手写的 `mastra.ag_ui_*` 迁移，然后提交。

`template/starter/` 是唯一需要随平台契约一起改的副本；CI 的 “Platform template stays buildable” 步骤会在它与平台不一致时失败。

## 4. 已知的剩余混合

- `packages/db/scripts/migrate-production.ts` 保留了本仓库从 `db:push` 迁到迁移序列时的一次性基线逻辑；在新库上是空操作。
- 平台内部标识仍带 `northwind` 前缀（Mastra storage id、侧栏 DOM id、日志字段）；本仓库保留以免影响已持久化状态，导出时替换。

## 5. 订阅模板约束

- Stripe 是支付与订阅状态的外部权威；Better Auth 官方插件验证 Webhook 并维护本地 projection。
- 权益读取本地 projection，不在请求路径同步调用 Stripe，也不因 success redirect 直接授权。
- `active` / `trialing` 授权；非终止异常状态进入 Portal 修复且禁止第二次 Checkout；
  `canceled` / `incomplete_expired` 才允许新建订阅。
- 前端只读取安全 catalog/status DTO；Price ID、Customer ID、Subscription ID 与 secret 不出服务端。
- Hosted Checkout 和 Customer Portal 处理支付资料；应用不存储卡号。

部署和 Stripe Dashboard 的逐项配置见[订阅运行手册](./subscriptions.md)。
