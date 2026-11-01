# 平台模板：基础能力与业务代码的边界

> 状态：Current · 2026-10-31
> 原则：业务代码只放在四个固定位置；平台代码只经由入口文件触达业务。模板由脚本从本仓库导出，不手工维护副本。

## 1. 平台提供什么

| 能力 | 位置 |
| --- | --- |
| 账号：邮箱密码 + OTP 验证、Google / GitHub / Apple 登录、iOS 原生登录、账号删除 | `packages/auth`、`apps/web/src/routes/login.tsx`、`_auth/` |
| 支付：Stripe Checkout / Portal 订阅、App Store 内购订阅（`better-auth-app-store`） | `packages/auth`、`packages/billing`、`packages/better-auth-app-store` |
| 对象存储：Cloudflare R2（S3 API），按用途登记类型、大小、链接时效与 Free/Pro 额度；浏览器直传（`storage:cors`）、用户上传台账与每小时清理（[文档](./object-storage.md)） | `packages/api/src/object-storage.ts`、`user-objects.ts`、`routers/uploads.ts` |
| Agent 运行骨架：Mastra 存储/记忆/观测、耐久化 AG-UI run、线程 API、CopilotKit 侧栏、按套餐限额 | `apps/server/src/mastra`、`apps/web/src/components/copilot` |
| Admin：用户与角色、运行配置、App Store 诊断、客户端配置、反馈收件箱 | `packages/api`、`apps/web/src/routes/admin` |
| 分析：PostHog、区域化同意、身份拼接、服务端转化事件 | `packages/analytics`、`apps/web/src/lib/analytics*.ts` |
| 运维：镜像、迁移优先启动、`/livez` `/readyz` `/internal/metrics`、加密备份 | `apps/*/Dockerfile`、`docker-compose.yml`、`scripts/` |

## 2. 业务代码在哪里

| 位置 | 内容 | 平台经由的入口（契约） |
| --- | --- | --- |
| `packages/product` | 业务 schema、tRPC 路由、业务 env（`productEnv`）、助手工具契约、e2e 步骤（`e2e.ts`） | `router.ts`（组合 `appRouter`）、`assistant-contracts.ts`（`ASSISTANT_AGENT_ID`、`ASSISTANT_PAGE_TOOL_NAMES`、`AssistantPageContext`）；`db:post-migrate` 脚本 |
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
bun scripts/export-template.ts ../my-app --scope @acme --brand Acme --domain acme.com [--config template.json]
bun scripts/export-template.ts --check       # Template 工作流同款：导出到 .template-check 并跑 check-types + test
bun scripts/template-update.ts ../my-app     # 把平台的新提交以三方合并带给已导出的仓库
```

导出脚本（`scripts/export-template.ts`）：

1. 复制该提交里的平台文件，跳过上表四处业务位置、业务文档、`infra/`、IAP 开发隧道和导出/更新脚本本身；
   发布链路（`deploy.yml`、Dokploy 供给、`deploy:github`、冒烟脚本、`.env.dokploy.example`）与平台文档一并导出；
2. 用 `template/starter/` 覆盖业务位置：首页、`example.hello`、无工具的助手、占位法律页、部署与冒烟钩子、模板文档与 README；
   再叠加 `template/examples/*/`（同路径整文件覆盖；`--no-examples` 跳过）。目前只有「我的笔记」：用户数据、浏览器直传对象存储、
   Free/Pro 附件额度、助手只读工具卡片与需确认的前端工具、Admin 统计、分析事件和 e2e 步骤；
3. 写入项目身份：scope、品牌、域名（Web/API/邮件/PostHog 代理）、`apple-application.ts`（`--config` 的 `apple` 块，
   缺省为占位 App 且 `APP_STORE_ENABLED=false`），模板发布策略默认 `REQUIRED_INTEGRATIONS=email`；
4. 门禁：导出结果里残留本仓库身份（域名、Bundle ID、App ID、命名空间、本机路径等）、平台代码里的业务引用或死链时导出失败；
5. `git init`、`bun install`，生成仅含平台表的基线迁移与手写的 `mastra.ag_ui_*` 迁移，记录 `.template.json` 与 `.template-source` 后提交。

`template/starter/` 与 `template/examples/` 是需要随平台契约一起改的副本；`.github/workflows/template.yml`（仅本仓库）分别导出带示例与不带示例的模板，
任一与平台不一致都会失败。`template:update` 对未记录 `examples` 的旧派生仓库按不带示例处理，不会把示例合进已有业务。

导出的仓库自带：`bun run doctor`（本地）/ `doctor --deploy`（发布前，逐项对真实服务做一次请求）、
`bun run e2e`（生产构建 + compose 中的 PostgreSQL、Mailpit、S3 与 mock 模型，Playwright 走注册→验证码→助手→业务步骤（`packages/product/e2e.ts`）→
axe 无障碍检查（serious/critical 即失败）→截图→Admin，配置 `E2E_STRIPE_*` 测试密钥时含 Stripe Checkout；mock 模型可按规则发出
DeepSeek/OpenAI 格式的 `tool_calls`；CI 单独一个 job），以及三步上线
`deploy:provision` → `deploy:github --apply` → `deploy:production`（见模板的 `docs/deployment.md`）。

`scripts/template-update.ts` 用派生仓库自己的答案分别导出它的源提交与新提交，把两者之差以 `git apply --3way` 应用过去：
业务代码与本地修改保留，真正的重叠变成普通冲突标记；不提交，平台 schema 变化时提示 `db:generate`。

### 质量门禁

- `bun run check:boundaries`：平台只经由入口触达业务。
- `bun run test:postgres`：全部 PostgreSQL 集成测试组，各用一个新建的库；CI、发布门禁与本地跑同一份清单。
- `bun run check:unused`（knip）：未使用的文件、依赖直接失败；未使用的导出与类型只告警——平台库导出的接口与类型
  是给业务调用的公共 API，在只有 starter 的模板里自然无人引用。
- 导出脚本只复制文件并写入身份（scope、品牌、域名、iOS App 身份）；业务内容全部由 `template/starter` 覆盖提供，
  不对共享文件做逐行改写。

## 4. 已知的剩余混合

- `packages/db/scripts/migrate-production.ts` 保留了本仓库从 `db:push` 迁到迁移序列时的一次性基线逻辑；在新库上是空操作。
- 平台内部标识仍带 `northwind` 前缀（Mastra storage id、侧栏 DOM id、日志字段）；本仓库保留以免影响已持久化状态，导出时替换。
- 迁移 `0020_runtime_settings` 只复制、不删除 `operational_settings(_audit)`；本次发布完成后用一条后续迁移删除这两张表。
- 随模板导出的部分平台文档写于本产品时期，示例中仍可能提到榜单等页面（接口合同适用）。

## 5. 订阅模板约束

- Stripe 是支付与订阅状态的外部权威；Better Auth 官方插件验证 Webhook 并维护本地 projection。
- 权益读取本地 projection，不在请求路径同步调用 Stripe，也不因 success redirect 直接授权。
- `active` / `trialing` 授权；非终止异常状态进入 Portal 修复且禁止第二次 Checkout；
  `canceled` / `incomplete_expired` 才允许新建订阅。
- 前端只读取安全 catalog/status DTO；Price ID、Customer ID、Subscription ID 与 secret 不出服务端。
- Hosted Checkout 和 Customer Portal 处理支付资料；应用不存储卡号。

部署和 Stripe Dashboard 的逐项配置见[订阅运行手册](./subscriptions.md)。
