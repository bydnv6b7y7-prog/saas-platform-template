# Northwind 平台模板

[English](README.md) | **简体中文**

一个 Bun + Turborepo monorepo，SaaS 中与具体业务无关的那一半已经可用：账号、支付、文件上传、AI 助手、
管理后台、数据分析，以及一条命令即可发布的流水线。你只写业务；平台部分可以持续从上游更新。

- [功能](#功能)
- [本地运行](#本地运行)
- [需要你亲自完成的操作](#需要你亲自完成的操作)
- [部署](#部署)
- [业务代码放在哪里](#业务代码放在哪里)
- [保持更新](#保持更新)
- [文档](#文档)

## 功能

| 领域 | 开箱即用的能力 | 代码位置 |
| --- | --- | --- |
| 账号 | 邮箱 + 密码注册（邮件验证码）；Google / GitHub / Apple 登录；iOS 原生登录；会话；注销账号 | `packages/auth`、`apps/web/src/routes/login.tsx` |
| 邮件 | 通过 Cloudflare Email Sending 发送注册验证码；本地所有邮件进入 Mailpit | `packages/auth` |
| 支付 | Stripe Checkout 与 Customer Portal 订阅（Pro 月付 / 年付）；App Store 内购订阅；两者共用一套权益判断 | `packages/billing`、`packages/better-auth-app-store` |
| 文件上传 | Cloudflare R2（或任意 S3 API）：浏览器直传到桶；每种上传用途声明文件类型、大小上限和 Free / Pro 配额；按文件内容校验类型，每小时清理 | `packages/api/src/object-storage.ts`、`user-objects.ts`、`routers/uploads.ts` |
| AI 助手 | Mastra agent + CopilotKit：流式运行且刷新不中断、私有对话历史、工具结果渲染为卡片、需用户确认的操作、按套餐限额；支持 DeepSeek、OpenRouter 或任意 OpenAI 兼容模型 | `apps/server/src/mastra`、`apps/web/src/components/copilot` |
| 管理后台 | 用户与角色、助手额度（带审计）、App Store 诊断与测试通知、iOS App 远程设置、反馈收件箱、你自己的业务页签 | `apps/web/src/routes/admin`、`packages/api` |
| iOS App 支持 | 远程设置、带截图的应用内反馈、评分提示 | `apps/server/src/app-client` |
| 数据分析 | PostHog，按地区征求同意、注册 / 购买来源归因、服务端转化事件 | `packages/analytics` |
| 质量门禁 | 类型检查、单元测试、PostgreSQL 集成测试、平台 / 业务边界检查、使用脚本化 AI 模型的端到端浏览器测试、无障碍（axe）检查 | `scripts/`、`test/e2e` |
| 运维 | `bun run doctor` 对每项配置向真实服务发请求检查；Docker 镜像按 Git SHA 固定；先迁移再启动；健康 / 就绪 / 指标接口；加密的 PostgreSQL 备份与恢复演练 | `apps/*/Dockerfile`、`scripts/` |
| 发布 | 合并到 `main` → GitHub Actions 校验、并行构建镜像、迁移、部署到 Dokploy，并对线上站点做冒烟测试（约 6 分钟） | `.github/workflows/deploy.yml` |

每个集成（Stripe、OAuth 登录、R2、PostHog、App Store）在整组变量都设置时开启，整组留空时关闭。
只填了一半会在启动时被拒绝，而不是被静默忽略。

### 示例：我的笔记

除非模板以 `--no-examples` 导出（`.template.json` 中 `"examples": false`），它会带上 **我的笔记（My notes）**：
一个同时用到所有平台能力的示例——按用户隔离的数据、直传对象存储的附件、Free / Pro 配额、带卡片的助手工具和
保存前需确认的操作、Admin 页面、分析事件与 e2e 步骤。docs 目录中的 `example-notes.md` 说明了它的结构以及如何删除。

## 本地运行

需要：[Bun](https://bun.sh) 1.4.4 和 Docker。

```bash
cp apps/server/.env.example apps/server/.env   # 设置 BETTER_AUTH_SECRET（openssl rand -base64 32）
cp apps/web/.env.example apps/web/.env
bun install
bun run db:start          # PostgreSQL 18 + Mailpit（注册验证码在 http://localhost:8025）
bun run db:migrate        # 平台表、业务迁移和助手的存储
bun run doctor            # 检查每项配置并告诉你下一步
bun run dev               # Web http://localhost:3001，API http://localhost:3000
```

- 除助手外，所有功能都不需要模型 key；在 `apps/server/.env` 加上 `DEEPSEEK_API_KEY`（或其他模型服务，见
  [AI 助手](docs/ai-assistant.md)）即可开启助手。
- 端口被占用？`POSTGRES_PORT=5440 MAILPIT_PORT=8026 bun run db:start` 并同步修改 `DATABASE_URL` / `EMAIL_DEV_MAILPIT_URL`；
  API 改 `PORT`（以及 `BETTER_AUTH_URL`，和 `apps/web/.env` 里的 `VITE_SERVER_URL`、`SERVER_URL`）。
  `bun run doctor` 会报告被占用的端口；`bun run dev:kill` 只停止本目录自己的服务。
- `.env` 只在启动时读取：修改后重启 `bun run dev`。
- 门禁：`bun run check-types`、`bun run test`、`bun run test:postgres`、`bun run check:boundaries`、`bun run e2e`。

## 需要你亲自完成的操作

以下每一项都需要注册账号、进入某个控制台或由你做决定。代码都已就绪；`bun run doctor`（本地）和
`bun run doctor --deploy`（生产）会对每一项发起真实请求检查，并告诉你还缺什么。

### 本地

| 步骤 | 做法 | 是否必需 |
| --- | --- | --- |
| 生成认证密钥 | `openssl rand -base64 32` → 写入 `apps/server/.env` 的 `BETTER_AUTH_SECRET` | 必需 |
| 把自己设为管理员 | 注册后运行 `bun run admin:lookup you@example.com`，把 id 写入 `ADMIN_USER_IDS`，重启 `bun run dev` | 使用管理后台时 |
| 添加模型 key | 在 `apps/server/.env` 设置 `DEEPSEEK_API_KEY`（或 OpenRouter / OpenAI 兼容服务） | 使用助手时 |
| 本地测试支付 | 安装 Stripe CLI，设置四个 `STRIPE_*` 测试值，运行 `bun run dev:stripe` | 可选 |

### 生产所需的账号与服务

| 服务 | 需要创建什么 | 值写到哪里 |
| --- | --- | --- |
| [Dokploy](https://dokploy.com) 服务器 | 一台装好 Dokploy 的服务器；一个 API key（Settings → API/CLI） | `DOKPLOY_URL`、`DOKPLOY_API_KEY` |
| DNS | 两条指向该服务器的记录，例如 `app.example.com`（Web）和 `api.example.com`（API）；证书由 Dokploy 自动签发 | `VITE_WEB_URL`、`VITE_SERVER_URL` |
| GitHub | 存放本代码的仓库；本机执行 `gh auth login` | — |
| GitHub 镜像仓库（GHCR） | 一个带 `read:packages`、`write:packages` 权限的 Personal Access Token | `DOCKER_REGISTRY_USERNAME`、`DOCKER_REGISTRY_PASSWORD` |
| Cloudflare Email Sending | 一个发信域名，以及有 Email Sending 权限的账号 token | `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_EMAIL_API_TOKEN`、`EMAIL_FROM` |
| AI 模型 | DeepSeek / OpenRouter / OpenAI 兼容服务的 API key | `COPILOT_MODEL_PROVIDER` 及对应 key |

这些都写在 `.env.dokploy.local`（从 `.env.dokploy.example` 复制）。请妥善保管这个文件：首次供给会把生成的
`BETTER_AUTH_SECRET` 和数据库密码写回其中。

### 可选集成

| 集成 | 需要在服务商控制台完成的操作 | 详细说明 |
| --- | --- | --- |
| Stripe 订阅 | 创建 Pro 商品及月付、年付两个价格；添加 webhook `https://<API 域名>/api/auth/stripe/webhook`，事件为 `checkout.session.completed` 与 `customer.subscription.created / updated / deleted`；配置 Customer Portal（发票、支付方式、到期取消、在两个价格间切换）。测试模式和正式模式各做一遍 | [订阅](docs/subscriptions.md) |
| 文件上传（R2） | 创建一个 bucket 和一个仅限该 bucket 的 Object Read & Write token；然后运行 `bun run storage:cors --deploy` 设置 bucket 的 CORS 规则（token 无权设置时，它会打印 JSON，粘贴到 bucket 设置里即可） | [对象存储](docs/object-storage.md) |
| Google / GitHub / Apple 登录 | 创建 OAuth 应用；回调地址 `https://<API 域名>/api/auth/callback/{google,github,apple}`。Apple 网页登录还需要一个配置了你的域名和该回调地址的 Services ID | [登录](docs/native-ios-auth.md) |
| PostHog | 创建项目；为服务端和浏览器设置项目 token；在 `packages/env/src/posthog-hosts.ts` 填写你的反向代理地址 | [分析](docs/analytics.md) |
| App Store 订阅 | 在 `packages/env/src/apple-application.ts` 描述你的 App（Bundle ID、Apple ID、订阅组、商品）；创建 In-App Purchase 密钥；为 Production 与 Sandbox 设置服务器通知地址 `https://<API 域名>/api/auth/app-store/notifications`（V2）；在 Admin → Settings 发送一次测试通知 | [App Store](docs/app-store-subscriptions.md) |

想在某个集成缺失时拒绝发布，把它加入 `REQUIRED_INTEGRATIONS`。`DEPLOY_STAGE=staging` 只接受 Stripe 测试密钥，
`production` 只接受正式密钥。

### 首次发布之后

| 步骤 | 做法 |
| --- | --- |
| 第一个管理员 | 在线上站点注册，打开 `https://<API 域名>/api/auth/get-session`，把 `user.id` 写入 `.env.dokploy.local` 的 `ADMIN_USER_IDS`，运行 `bun run deploy:provision`，再重新运行最近一次 Deploy 工作流。之后的管理员可在 Admin → Users 直接授予 `admin` 角色 |
| 品牌与法律页面 | 替换 `VITE_BRAND_NAME`、`apps/web/public/brand/` 中的图形，以及 `apps/web/src/routes/(product)/` 中的占位隐私政策和服务条款 |
| 搜索引擎收录 | 法律页面定稿后，把 GitHub 变量 `PRODUCTION_ENABLE_INDEXING` 改为 `true` 并重新发布 |
| 备份 | 在 Dokploy 用 backup 镜像定时运行 `scripts/backup-postgres.sh`（需要一个 [age](https://age-encryption.org) 公钥和一个 S3 bucket），私钥离线保管，并定期运行 `scripts/restore-verify.sh`。见 [部署](docs/deployment.md#备份与恢复) |
| 修改服务端变量 | 编辑 `.env.dokploy.local`，运行 `bun run deploy:provision`，再重新部署（重跑工作流或合并一次改动） |

### 日常

| 任务 | 做法 |
| --- | --- |
| 发布 | 把 pull request 合并到 `main`，Deploy 工作流完成其余步骤 |
| 回滚 | 对旧提交重新运行 Deploy，或 `git revert` 后合并。迁移只向前：撤销 schema 改动要写一条新迁移 |
| 修改表结构 | 编辑 `packages/product/src/schema`，运行 `bun run db:generate`，审阅并提交迁移 |
| 平台更新 | 见 [保持更新](#保持更新) |

## 部署

Dokploy + GitHub Actions，填好 `.env.dokploy.local` 后执行（[部署文档](docs/deployment.md)）：

```bash
bun run doctor --deploy         # 每一行都是 ✓ 或 – 再继续
bun run deploy:provision        # Dokploy 项目、PostgreSQL、migration / API / web 应用、域名
bun run deploy:github --apply   # GitHub Actions 的 Secrets 与 Variables
bun run deploy:production       # 推送 main；工作流负责构建、迁移、部署和冒烟测试
```

只改源码的发布会复用镜像中已缓存的依赖层；改了任何 `package.json` 或 `bun.lock` 时会重新安装依赖。

## 业务代码放在哪里

平台代码只通过以下四个位置触达业务代码（由 `bun run check:boundaries` 强制检查）：

| 位置 | 约定 |
| --- | --- |
| `packages/product` | `router.ts` 用 `platformRouters` 加你的 tRPC 路由组成 `appRouter`；`assistant-contracts.ts` 声明助手 agent、前端工具和页面上下文类型；`env.ts` 放业务环境变量；`src/schema/` 放业务表；`db:post-migrate` 在迁移后运行；`deployment.ts` 声明额外变量、存储卷或后台 worker；`e2e.ts` 添加端到端测试步骤 |
| `apps/server/src/product/index.ts` | `assistantAgents`（Mastra agent，必须包含 `ASSISTANT_AGENT_ID`）与 `serverProduct`（服务名、就绪检查表、状态、指标、后台任务） |
| `apps/web/src/product/index.ts` 与 `assistant/index.tsx` | 导航、首页、管理后台页签 / 设置、SEO 与定价文案、sitemap；助手的页面上下文、页面工具、工具渲染和欢迎卡片 |
| `apps/web/src/routes/**/(product)/` | 你的页面；登录后可见的页面放在 `routes/_auth/(product)/`，管理页面放在 `routes/admin/(product)/`，以继承相应的访问控制 |

初始业务刻意保持最小：一个首页、一个 `example.hello` 接口和一个不带工具的助手。

## 保持更新

`.template.json` 和 `.template-source` 记录了本仓库的导出方式和来源提交。在平台仓库中运行
`bun scripts/template-update.ts <本仓库>`，会重新导出两个提交并以三方合并的方式只应用平台的改动，业务代码不会被覆盖。

## 文档

| 文档 | 内容 |
| --- | --- |
| [部署](docs/deployment.md) | 从空服务器到线上；备份；回滚 |
| [配置](docs/configuration.md) | 所有变量、可选集成、管理后台运行设置 |
| [平台边界](docs/platform-template.md) | 业务代码放在哪里 |
| [邮箱验证](docs/email-verification.md) | 注册验证码、Cloudflare Email Sending |
| [订阅](docs/subscriptions.md) | Stripe Checkout / Portal 与权益 |
| [App Store 内购](docs/app-store-subscriptions.md) | StoreKit 2：App 身份、凭据、服务器通知 |
| [登录](docs/native-ios-auth.md) | Google / GitHub / Apple、iOS 原生登录 |
| [对象存储](docs/object-storage.md) | 上传用途、配额、CORS、清理 |
| [AI 助手](docs/ai-assistant.md) | 运行骨架、额度、记忆 |
| [分析](docs/analytics.md) | PostHog、区域化同意、服务端事件 |
| [反馈与评分](docs/app-feedback-rating.md) | iOS 远程设置、带截图的反馈 |
| [账号删除](docs/account-deletion.md) | 删除什么、保留什么 |
