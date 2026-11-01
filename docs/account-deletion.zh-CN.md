# 账号删除

[English](account-deletion.md) | **简体中文**

更新于：2026-09-16。实现 App Store 审核指南 5.1.1(v)：支持创建账号的 App 必须允许用户删除其账号。

## 契约

| | |
| --- | --- |
| 端点 | `POST /api/auth/account/delete`（Better Auth 插件 `account-deletion`，`packages/auth/src/account-deletion.ts`） |
| 请求体 | `{ "email": "<account email>" }` —— 由服务端去除首尾空白并转为小写 |
| 认证 | Cookie 会话（`sessionMiddleware`）；适用 Better Auth 的 origin/CSRF 检查 |
| 身份确认 | 输入的邮箱必须与会话用户的邮箱一致，否则返回 `400 EMAIL_CONFIRMATION_MISMATCH`。客户端的“输入你的邮箱”对话框只是 UX，不是安全边界 |
| 限流 | 每个客户端 5 次请求 / 60 s |
| 响应 | `{ "success": true }`，同时清除会话 cookie（`Cache-Control: no-store`） |
| 与 Admin 一致 | `/admin/remove-user` 运行同一套例程（`createAdminAccess(…, { onDeleteUser })`）；省略该选项时保留原有行为 |
| Web UI | `/_auth/account/delete`（账号菜单 → Delete account）——同时也是原生 iOS App 的深链接目标 |

## 语义

删除是**立即且硬删除**——没有宽限期、没有待处理状态、没有定时任务。在同一个事务中对用户行执行的
`DELETE` 是唯一的原子提交点。每个外部副作用都是尽力而为、单独包裹的，绝不会阻塞删除；失败会被记录到
日志（`account_deletion.*` 事件）并写入返回的 `DeletedAccountFacts`。

`deleteUserAccount(userId)` 中的操作顺序：

1. **捕获**用户行和活跃的银行卡订阅
   （`subscription.referenceId = userId`、`cancel_at_period_end = false`、
   状态为 `active`/`trialing`/`past_due`）。
2. **Stripe**：对每个活跃订阅执行 `subscriptions.update(id, { cancel_at_period_end: true })`
   ——当前周期仍为已付费，不退款，不续订。失败时继续执行删除。
3. **助手历史**（由 `apps/server/src/mastra/account-cleanup.ts` 注册的 hook）：
   AG-UI 回放投影、Mastra 线程/消息/向量、observational memory，以及对 `mastra_thread_state` 和
   `mastra_resources` 行的原始清理（Mastra 的 `deleteThread` 不覆盖这些）。缺少 hook → 警告并跳过
   （例如没有服务端运行时的 CLI 进程）。
4. **PostHog**：通过批量 REST 端点删除 person 及其事件。以
   `POSTHOG_PERSONAL_API_KEY` + `POSTHOG_PROJECT_ID` 为开关（要么都配置，要么都不配置；只配置一部分
   会导致启动失败）。`posthog-node` 没有删除 API——项目 token 无法管理 person，必须使用个人 API key。
5. **数据库事务**：删除该邮箱的 `verification` 行（OTP + 两个策略租约标识符），按假名化主体哈希
   （`sha256("<BETTER_AUTH_SECRET>:<userId>")` —— 由于 `packages/auth` 不能导入 `packages/api`，
   它在 `account-deletion.ts` 中本地重复实现；由一个固定向量单元测试锁定）删除 `usage_buckets`，然后
   执行 `DELETE FROM user` —— 级联删除 `session`/`account` 行；将
   `iap_account`/`iap_subscription`/`stored_object` 上的 `user_id` 置为 NULL。受影响行数为零 →
   `USER_NOT_FOUND`（并发删除）。
6. 提交后通过 Cloudflare 发件器发送**确认邮件**，说明删除了哪些内容以及下文所述的订阅处理方式。

## 删除与保留

| 删除（级联或显式） | 按设计保留 |
| --- | --- |
| `user`、`session`、`account` | `subscription`（Stripe 账本；webhook 为权威来源） |
| 该邮箱的 `verification` 行 | `iap_account` / `iap_subscription` 行——匿名化的墓碑记录；保留 `claimed_at`（归属规则） |
| — | `iap_ownership_audit`、`iap_admin_action`、`runtime_settings_audit`、`app_client_config_audit`（明文的操作者 ID） |
| 该用户哈希对应的 `usage_buckets` 行 | |
| 用户的上传（`stored_object`）：`user_id` 置为 NULL，对象和行在下一次每小时清理时删除（[对象存储](./object-storage.zh-CN.md)） | |
| Mastra 线程/消息/状态/working memory | |
| 登录状态下发送的 `app_feedback`；其 R2 截图在下一次每小时清理时删除 | 未登录状态下发送的 `app_feedback`——从未与账号关联（[App 反馈](./app-feedback-rating.zh-CN.md)） |
| PostHog person + 事件（已配置时） | |

## 删除时的订阅处理

- **银行卡（Stripe）**：自动在周期结束时取消。保留的账本行使得用户行删除后 webhook 处理仍能正常工作；
  删除测试账号后，用 `stripe listen` + `dev:stripe` 进行验证。
- **Apple IAP**：无法在服务端取消。删除页面和确认邮件都会提示用户前往
 App Store → 订阅 中取消。

## 测试

- 单元测试：`packages/auth/src/account-deletion.test.ts`（verification 标识符集合、用量哈希固定向量、
  PostHog 请求结构）。
- 集成测试（仅限专用数据库）：
  `ACCOUNT_DELETION_TEST_DATABASE_URL=postgres://…127.0.0.1/northwind_account_deletion_test bun test packages/auth/src/account-deletion.postgres.test.ts`
- Web：`apps/web/src/lib/account.test.ts`（请求结构 + 错误映射）。

## 原生 iOS 集成

使用共享的 cookie jar 提交已登录用户的邮箱，或深链接到 `https://<web-origin>/account/delete`。Apple
授权码 token 的吊销仍是一个单独审核的流程（参见[原生 iOS 认证](./native-ios-auth.zh-CN.md)）。
