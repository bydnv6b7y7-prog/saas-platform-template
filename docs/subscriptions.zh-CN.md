# 订阅与 Stripe 运行手册

[English](subscriptions.md) | **简体中文**

> 状态：Current · 2026-08-30
> 实现：Better Auth 1.7.2 官方 Stripe 插件 + Stripe Node 22.6.0 + Hosted Checkout/Portal。

## 1. 权威边界

Stripe 是支付和订阅生命周期的外部权威，Better Auth 插件负责验证 Stripe Webhook 并把状态同步到
PostgreSQL。应用只读这份 owner-scoped projection 判定权益，不在每个请求同步查询 Stripe，也不因浏览器
返回 success URL 直接授权。

管理员权限是独立的应用访问来源，不是 Stripe 订阅。Better Auth Admin Plugin 识别的管理员直接获得
Pro 产品额度，但仍受同一套 Pro 运行限额；应用不会伪造 subscription 记录，也不会要求付款。

官方依据：

- [Better Auth Admin plugin](https://better-auth.com/docs/plugins/admin)：管理员角色与 bootstrap user id；
- [Better Auth Stripe plugin](https://better-auth.com/docs/plugins/stripe)：官方插件、客户端、schema、Webhook 和 Portal；
- [Better Auth hooks](https://better-auth.com/docs/concepts/hooks) 与
  [rate limiting](https://better-auth.com/docs/concepts/rate-limit)：服务端前置校验、endpoint 规则与扩容时共享存储；
- [Stripe products and prices](https://docs.stripe.com/products-prices/how-products-and-prices-work)：Product/Price 的权威模型；
- [Stripe subscriptions integration](https://docs.stripe.com/billing/subscriptions/build-subscriptions)：Hosted Checkout、Webhook provision 和 Portal；
- [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)：异步状态变化和访问控制；
- [Stripe API keys](https://docs.stripe.com/keys)：secret/restricted key 只在服务端和 secret store 中使用；
- [Stripe advanced fraud detection](https://docs.stripe.com/disputes/prevention/advanced-fraud-detection)：Hosted Checkout/Stripe.js 可能按风控加载 hCaptcha；
- [Better Auth 1.7 upgrade](https://better-auth.com/docs/guides/1-7-upgrade-guide)：issuer/accountId 身份迁移与维护窗口要求。

## 2. Stripe Dashboard 一次性配置

### Product 与 Price

创建一个代表同一权益的 `Northwind Pro` Product，并在该 Product 下创建两个固定 recurring Price：

| 环境变量 | Stripe interval | Better Auth plan |
| --- | --- | --- |
| `STRIPE_PRICE_PRO_MONTHLY` | month × 1 | `pro-monthly` |
| `STRIPE_PRICE_PRO_YEARLY` | year × 1 | `pro-yearly` |

两个 Price 必须 active、同 Product、使用 USD、固定正整数金额。服务启动后 catalog 会从 Stripe 读取并
验证这些属性，前端不保存价格，也不会收到 Price ID。

不要为同一权益的不同计费周期创建多个 Product。价格和周期是 Price 的属性；Product 表示卖的东西。

当前自助式包装只有两个权益层级：

| 层级 | 价格 | 权益边界 |
| --- | --- | --- |
| Free | $0 | 最新与历史榜单、数据新鲜度与覆盖率、私有会话历史，以及每天 5 次完整 Northwind AI 请求 |
| Northwind Pro | $20/月或$200/年 | Free 全部能力，以及每天 100 次 Northwind AI 请求 |

年付在界面按 `$16.67/month` 展示，同时必须明确标注 `$200 billed yearly` 和节省 17%。周付已停止
销售；Stripe 中的旧 Price 保持 inactive，不再进入应用配置或新 Checkout。

### Webhook

创建 endpoint：

```text
https://<API_DOMAIN>/api/auth/stripe/webhook
```

至少订阅：

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

把 endpoint 自己的 signing secret 保存为 `STRIPE_WEBHOOK_SECRET`。它不是 API key，测试和生产 endpoint
各有独立 secret。签名验证和事件处理由 Better Auth 官方插件完成，不再编写第二套 Webhook handler。

本地 Sandbox 使用 Stripe CLI 转发同一组事件；`apps/server/.env` 中的 signing secret 必须来自当前 CLI
profile。项目已提供入口：

```sh
bun run dev:stripe
```

它将事件转发到 `http://localhost:3000/api/auth/stripe/webhook`。本地开发时需要与 `bun run dev` 同时运行。

### Customer Portal

分别在 Sandbox 与 Live mode 配置 Portal：品牌、invoice history、payment method update、cancel at period
end，以及允许切换的月付和年付 Pro Price。应用只创建短期 Portal session，不复制账单管理 UI。

Hosted Checkout 位于 `checkout.stripe.com`。Stripe 可能在该托管页加载 hCaptcha 作为高级欺诈
信号；正常用户通常不会看到交互题，只有风控要求挑战时才在支付页出现。它不在 Northwind
源码或 Stripe Dashboard 的独立设置菜单中，也不应另外集成或默认关闭。排障时在 Checkout
页浏览器 Network 中筛选 `hcaptcha`，不要把自动化浏览器被挑战误判为应用故障。

### Secret key

优先创建 restricted key；当前 Stripe Dashboard 的最小权限为 Customers 写、Products 读、Prices 读、
Subscriptions 写、Checkout Sessions 写、Customer Portal 写。Webhook 签名在本地验证，不给运行时密钥
Webhook Endpoints 权限。若平台有稳定出口 IP，再增加 IP allowlist。定期轮换并检查 Stripe API logs。

## 3. 服务端环境变量

整组留空表示本地禁用；只填写一部分会在启动时 fail fast：

```dotenv
STRIPE_SECRET_KEY=rk_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_PRICE_PRO_MONTHLY=price_xxx
STRIPE_PRICE_PRO_YEARLY=price_xxx
```

生产值放在被 Git 忽略的 `.env.dokploy.local`（或同名进程环境变量），由供给脚本注入 Dokploy，仅进入 API
容器；本地 `apps/server/.env` 永远保留 Sandbox 值。供给脚本会拒绝 test/claimable key，部署 smoke 还会
再次检查 `/readyz` 的 `billing.livemode=true`，防止配置回退。当前使用 Hosted Checkout，因此浏览器不需要
publishable key。

首次从 Sandbox 切换到 Live 时，迁移 `0011_stripe_live_cutover` 只终结从未生成 Stripe Subscription、
且与所属用户 Customer ID 精确匹配的废弃 Checkout 占位记录，同时清除该用户的旧 Sandbox Customer
ID。已有 Stripe Subscription、其他用户和任何无法可靠识别的记录都不会被修改；之后 Better Auth 会在
用户首次 Live Checkout 时创建新的 Live Customer。

## 4. 状态与权益策略

| Stripe 状态 | Pro 权益 | 用户行动 | 是否允许新 Checkout |
| --- | --- | --- | --- |
| `active`, `trialing` | 是 | 正常使用；可进 Portal | 否 |
| `past_due`, `unpaid`, `paused`，或已有 Stripe Subscription ID 的 `incomplete` | 否 | 进入 Portal 修复 | 否 |
| 尚未生成 Stripe Subscription ID 的本地 `incomplete` Checkout 占位 | 否 | 重新发起 Checkout | 是 |
| 未知的非终止状态 | 否（fail closed） | 进入 Portal/人工检查 | 否 |
| `canceled`, `incomplete_expired` | 否 | 可重新订阅 | 是 |

`cancel_at_period_end=true` 时 Stripe 状态在实际结束前仍为 active，因此权益持续到 `periodEnd`。Better
Auth 会在最终 success URL 前使用中间跳转等待 Webhook projection；浏览器仍只触发重新读取，不自行写入
或授予权限。

`GET /api/billing/status` 只按 Better Auth session 的 `user.id` 查询，不接受客户端 resource ID；响应不含
Customer ID、Subscription ID、resourceId 或内部 metadata。若状态读取失败，Pricing 会禁用 Checkout，
避免生成重复订阅。

AG-UI Runtime 会在服务端读取同一份订阅 projection，并把登录用户映射为 Free 或 Pro 额度；自定义
assistant thread 接口对所有登录用户开放。权益来源按 `admin → subscription → free` 判定：管理员获得
Pro 额度但不产生 Stripe subscription；订阅用户必须由 Webhook projection 的 `grantsAccess=true` 授权；
其余用户使用 Free 额度。Free 默认最多 5 次运行/5 分钟、5 次运行/UTC 日，Pro 默认最多 10 次运行/5
分钟、100 次运行/UTC 日。只有用户主动发起的 Agent Run 才会预留额度，失败或取消的运行会释放预留。
计数写入现有 PostgreSQL `usage_buckets`，以不可逆用户哈希作为主体，跨实例一致，不依赖进程内计数。

额度在 Admin → Settings（`/admin/config`）维护。每次新运行和用量查询读取同一份
数据库配置，当前运行继续使用原额度快照；修改额度不清空已有用量。首次保存前兼容四项
`ASSISTANT_*_RUN_LIMIT_*` 环境变量，缺省值来自共享合同。首次实际保存后全部额度由数据库接管。

配置快照与修改人、时间、版本和前后值审计使用新增迁移 `0013_operational_settings.sql`；
用量计数继续复用 `usage_buckets`。默认值、并发保存与发布步骤见[配置与 Admin Settings](./configuration.zh-CN.md)。

Better Auth 的生产默认 rate limit 保持启用；创建 Checkout 与 Portal session 另外限制为每个来源每分钟
10 次。`/subscription/upgrade` 还有服务端 before hook：只要本地仍有非终止订阅，就拒绝新 Checkout，
管理员同样被拒绝新 Checkout，不能通过绕过前端制造重复订阅或无意义付费。已有真实订阅仍可进入 Portal
取消，管理员产品访问不随该订阅结束。当前 Dokploy 是单个常驻 API 实例，因此沿用官方默认内存计数；横向
扩容前必须改为 Better Auth 的 PostgreSQL 或共享 secondary storage。Webhook 不套用该自定义限流，避免
阻断 Stripe 的合法重试。

## 5. 数据库变更与发布

管理员访问来源复用 Better Auth 现有 `role` / `ADMIN_USER_IDS` 与运行时投影，不新增表或字段，因此该策略
本身不需要 `db:push` 或新 migration。以下迁移说明只适用于首次安装现有 Stripe 集成。

本次必须使用：

```sh
bun run db:migrate
```

不要使用 `bun db:push`：共享/生产数据库需要版本化、可评审、可重复的 SQL migration。

迁移 `0009_better_auth_stripe.sql` 同时完成：

- Better Auth 1.7 必需的 `account.issuer` backfill 和 `(issuer, accountId)` unique index；
- `user.stripe_customer_id`；
- Better Auth Stripe 官方 `subscription` 表和查询索引。

迁移 `0011_stripe_live_cutover.sql` 只处理 Sandbox → Live 的一次性遗留占位：它终结从未获得
Stripe Subscription ID/周期状态、且 Customer ID 与 owner 精确一致的 `incomplete` 行，再清除
同一 owner 的 Sandbox Customer ID。任何真实订阅、跨用户或语义不明确的行都保持不变。

上线前应备份 `user`/`account`，在维护窗口暂停登录写入，并先盘点：

```sql
SELECT provider_id, count(*) FROM account GROUP BY provider_id ORDER BY provider_id;
```

迁移只认可本部署实际启用的 credential、Google、GitHub、Apple。存在其他 provider 会中止迁移，必须先
根据可信 provider issuer 做显式映射并检查 collision，不能按邮箱合并用户。

## 6. Sandbox 回归与 Live 验收

每次改变计费逻辑，都先在 Stripe Sandbox 完成：

1. 新用户分别完成月付和年付 Checkout，Webhook 后显示正确金额、周期和 active 状态；
2. 重复点击 Pricing 只进入 Billing/Portal，不生成第二个 Subscription；
3. Portal 切换周期、更新卡、设置 period-end cancellation，状态经 Webhook 回写；
4. 使用 Stripe 测试卡制造 payment failure，应用撤销权益、提示修复且禁止新 Checkout；
5. 取消真正结束后可重新订阅；跨用户无法读取或管理另一个 Subscription；
6. 重放 Webhook 不产生重复记录；签名错误返回失败；API 日志不出现 key、签名、Customer ID；
7. `bun test`、`bun run check-types`、`bun run build`、空库 migration 和 migration idempotency 全部通过。

Live 基线已于 2026-08-30 验证：生产 `/readyz` 报告 `billing.configured=true` 与
`billing.livemode=true`；年付入口创建 Live `subscription` Checkout，金额为 USD 200/年；验收
session 保持未支付并未授予权益。生产 smoke 固定要求 configured + Live，避免部署回退到 Sandbox。

Live `Northwind Pro` Product 当前保存 Stripe tax code `txcd_10701400`（Website Information
Services — Business Use）。商品 tax code 只是税务分类，不等于已经启用 automatic Stripe Tax。
当前仍未自动开启 Stripe Tax、优惠码、trial、seat、删除用户时取消订阅或自建邮件催款。税务
注册地与义务确认后，再按 [Stripe Tax for Checkout](https://docs.stripe.com/tax/checkout) 单独评审；
不要用技术默认值替代税务决定。
