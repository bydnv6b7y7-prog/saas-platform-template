# 部署：从空服务器到线上

[English](deployment.md) | **简体中文**

目标：一台装好 [Dokploy](https://dokploy.com) 的服务器、一个 GitHub 仓库、两个域名，三条命令上线。
每一步都可以用 `bun run doctor --deploy` 检查，它会对每个外部服务做一次真实请求并给出下一步。

## 0. 准备

| 需要 | 用途 |
| --- | --- |
| Dokploy 服务器与 API key（Settings → API/CLI） | 运行 PostgreSQL、迁移、API、Web |
| 两个 DNS A 记录指向该服务器，例如 `app.example.com`、`api.example.com` | Web 与 API；Dokploy 用 Let's Encrypt 签证书 |
| GitHub 仓库 + `gh auth login` | Actions 构建镜像并按序发布 |
| GitHub PAT（`read:packages`、`write:packages`） | 推送与拉取 `ghcr.io/<命名空间>/*` 镜像 |
| Cloudflare Email Sending 发信域名与 token | 注册验证码（生产唯一必需的集成） |
| LLM key（DeepSeek / OpenRouter / OpenAI 兼容） | 助手；缺失时 `/readyz` 为 not_ready |

可选：Stripe（卡订阅）、PostHog（分析）、R2（上传，开启后跑 `bun run storage:cors --deploy`）、Google/GitHub/Apple 登录、App Store 内购。
它们各自整组配置即开启，整组留空即关闭；想让某项缺失时拒绝发布，把它加入 `REQUIRED_INTEGRATIONS`。

## 1. 填写 `.env.dokploy.local`

```bash
cp .env.dokploy.example .env.dokploy.local
```

按文件里的注释填写。`DEPLOY_STAGE=staging` 只接受 Stripe Test 密钥，`production` 只接受 Live 密钥。
`BETTER_AUTH_SECRET` 与数据库密码留空，首次供给会生成并回写到该文件——**保管好它**，丢失会让已有会话与数据库连接失效。

## 2. 供给 Dokploy

```bash
bun run deploy:provision
```

幂等：建项目、PostgreSQL、`<项目>-migration`、`<项目>-server`、`<项目>-web`（产品在
`packages/product/src/deployment.ts` 声明 worker 时再加一个），配置镜像、环境变量与域名，并把
applicationId 回写 `.env.dokploy.local`。重复运行只补缺失配置；修改了 `.env.dokploy.local` 的服务端变量后重跑一次即可。

## 3. 写入 GitHub Actions 配置

```bash
bun run deploy:github           # 预览
bun run deploy:github --apply   # 写入 Secrets 与 Variables（不打印密钥）
```

## 4. 发布

```bash
bun run doctor --deploy   # 全部 ✓ 或 – 再继续
bun run deploy:production # 检查本地 main、跑门禁、推送；然后跟踪工作流
```

`.github/workflows/deploy.yml` 在 `main` 上：校验发布合同 → 类型检查、测试、构建、PostgreSQL 集成测试、
空库迁移两次、SSR 冒烟 → 构建并推送镜像（按 Git SHA 固定）→ 依次部署 migration → server → web（→ worker），
每一步等到新 SHA 生效 → 对线上域名跑 `scripts/api-smoke.sh` 与 `scripts/web-smoke.sh`。

## 5. 上线后

1. 第一个管理员：在 Web 注册并登录，浏览器打开 `https://<API 域名>/api/auth/get-session`，复制 `user.id`，
   写入 `.env.dokploy.local` 的 `ADMIN_USER_IDS`，重跑 `bun run deploy:provision`，再在 GitHub Actions 重新运行最近一次 Deploy
   （或推送一个提交）让 server 读到新变量。之后的管理员可以在 Admin → Users 里直接授予 `admin` 角色。
2. Stripe：Workbench → Webhooks 添加 `https://<API 域名>/api/auth/stripe/webhook`，事件
   `checkout.session.completed`、`customer.subscription.created|updated|deleted`，签名密钥写入 `STRIPE_WEBHOOK_SECRET`。
3. OAuth：各 provider 的回调为 `https://<API 域名>/api/auth/callback/{google|github|apple}`。
4. 收录：确认法律页面后，把 GitHub Variable `PRODUCTION_ENABLE_INDEXING` 改为 `true` 再发布。

## 备份与恢复

`apps/backup/Dockerfile` 提供定时备份与恢复演练运行时（`scripts/backup-postgres.sh`、`scripts/restore-verify.sh`）：
`pg_dump` 用 [age](https://age-encryption.org) 加密后上传到任意 S3 兼容存储，按日/周保留。

| 变量 | 含义 |
| --- | --- |
| `DATABASE_URL` | 要备份的数据库 |
| `BACKUP_AGE_RECIPIENT` | age 公钥；私钥离线保管 |
| `BACKUP_S3_BUCKET` / `BACKUP_S3_ENDPOINT` / `BACKUP_S3_PREFIX` | 目标桶、端点、前缀 |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | 该桶的写入凭据 |
| `BACKUP_DAILY_KEEP` / `BACKUP_WEEKLY_KEEP` | 保留份数 |
| `BACKUP_AGE_IDENTITY_FILE`、`RESTORE_VERIFY_*` | 恢复演练：私钥文件与临时数据库 |

在 Dokploy 用该镜像建一个定时任务（Schedules）运行 `scripts/backup-postgres.sh`，并定期运行 `scripts/restore-verify.sh`
证明备份可恢复。

## 回滚

镜像按 Git SHA 不可变。回滚 = 在 GitHub Actions 对旧提交重新运行 Deploy，或 `git revert` 后推送 `main`。
迁移只向前；需要撤销的 schema 改动写一条新的评审迁移。
