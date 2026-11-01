# 配置：变量归属与生效边界

[English](configuration.md) | **简体中文**

环境变量负责凭据与部署；日常运营值（助手额度等）在 Admin → Settings 修改并带审计。
每个变量都由 zod 合同校验（`packages/env/src/*`），启动时缺失或格式错误会直接拒绝启动，而不是带病运行。
`bun run doctor` 按下表逐项检查并给出下一步。

## 1. 本地开发（`apps/server/.env`、`apps/web/.env`）

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 是 | `bun run db:start` 启动的 PostgreSQL 18 |
| `BETTER_AUTH_SECRET` | 是 | ≥ 32 字符：`openssl rand -base64 32` |
| `BETTER_AUTH_URL` / `CORS_ORIGIN` | 是 | API 与 Web 的本地地址 |
| `EMAIL_DEV_MAILPIT_URL` | 本地推荐 | 验证码投递到 Mailpit（<http://localhost:8025>）；生产禁止设置 |
| `COPILOT_MODEL_PROVIDER` + 对应 key | 助手需要 | `deepseek` / `openrouter` / `openai-compatible`（`LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`），见 [AI 助手](./ai-assistant.zh-CN.md) |
| `APP_STORE_ENABLED` | 是 | 模板默认 `false`；有 App Store Connect 凭据后改 `true`，见下文 |
| `ADMIN_USER_IDS` | 否 | 注册后 `bun run admin:lookup you@example.com` 取 id |
| `VITE_SERVER_URL` / `VITE_WEB_URL` / `VITE_BRAND_NAME` | 是（Web） | 构建期注入浏览器 |

## 2. 可选集成（整组设置即开启，整组留空即关闭）

| 集成 | 变量 | 文档 |
| --- | --- | --- |
| 邮件（生产） | `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_EMAIL_API_TOKEN`、`EMAIL_FROM` | [邮箱验证](./email-verification.zh-CN.md) |
| Stripe 订阅 | `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`STRIPE_PRICE_PRO_MONTHLY`、`STRIPE_PRICE_PRO_YEARLY` | [订阅](./subscriptions.zh-CN.md)；本地 `bun run dev:stripe` 转发 webhook |
| 对象存储（R2） | `R2_ENDPOINT`、`R2_BUCKET`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`（`R2_REGION`）；浏览器直传再跑 `bun run storage:cors` | [对象存储](./object-storage.zh-CN.md) |
| PostHog | `POSTHOG_PROJECT_TOKEN`（服务端）、`VITE_POSTHOG_PROJECT_TOKEN`（浏览器） | [分析](./analytics.zh-CN.md) |
| Google / GitHub / Apple 登录 | `GOOGLE_*`、`GITHUB_*`、`APPLE_*` | [原生与 Web 登录](./native-ios-auth.zh-CN.md) |
| App Store 内购 | `APP_STORE_ISSUER_ID`、`APP_STORE_KEY_ID`、`APP_STORE_PRIVATE_KEY_BASE64`、`APP_STORE_ENVIRONMENTS` | [App Store 内购](./app-store-subscriptions.zh-CN.md) |

## 3. 项目身份（代码里，不是环境变量）

| 内容 | 文件 |
| --- | --- |
| iOS App：名称、Bundle ID、App Apple ID、订阅组、商品与权益、评分触发点、反馈场景 | `packages/env/src/apple-application.ts` |
| 浏览器端 PostHog 反向代理地址 | `packages/env/src/posthog-hosts.ts` |
| 品牌名 | `VITE_BRAND_NAME`（Web 构建）、`PRODUCTION_BRAND_NAME`（发布） |
| 品牌图形 | `apps/web/public/brand/*` |

模板导出时这些值来自导出配置（`.template.json`）。没有 iOS App 时保持占位值并让 `APP_STORE_ENABLED=false`。

## 4. Admin → Settings 的运行设置

助手额度（Free/Pro 每 5 分钟与每 UTC 日）存在 `runtime_settings` 的 `operations` scope：
首次保存前使用合同默认值；保存后以数据库快照为准，每次修改带修订号与审计。

产品自己的运行设置用同一机制登记一个新 scope：

1. `packages/product/src/<name>-settings.ts`：zod `strictObject` 合同与默认值；
2. `packages/product/src/routers/<name>-settings.ts`：`createSettingsStore(db, definition)` 与
   `createSettingsRouter(definition, store)`，在 `router.ts` 挂到 `config.<name>`；
3. `apps/web/src/product/index.ts` 的 `productAdminSettings` 加一项，组件里用 `RuntimeSettingsPanel`。

## 5. 部署

生产变量写在 `.env.dokploy.local`，见 [部署](./deployment.zh-CN.md)。
