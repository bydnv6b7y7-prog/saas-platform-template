# 邮箱验证

[English](email-verification.md) | **简体中文**

更新于：2026-09-12。Better Auth 仍固定在 1.7.2。

## 约定

| 关注点 | 事实来源与行为 |
| --- | --- |
| 身份 | `user.emailVerified` 由 Better Auth 负责。只有已存在的未验证账户才能完成邮箱验证。已验证账户继续使用密码或已配置的社交登录。 |
| 持久化 | 注册会创建一个未验证账户并返回 `token: null`。验证完成前，密码登录不会创建会话。OTP 值加密存放在现有的 `verification` 表中。不需要新的 schema 迁移。 |
| 时间 | 六位数字，五分钟过期，允许输错三次，只能使用一次。重新发送会删除所有旧验证码。共享的 UI 常量位于 `packages/env/src/email.ts`；策略由服务端强制执行。 |
| 投递 | Cloudflare REST 必须将目标收件人标记为已投递或已入队。退信、抑制名单、格式错误的响应、HTTP 失败和超时都会返回一个经过脱敏的 `503`。入队成功不等于已送达收件箱。 |
| 会话 | 验证成功后，在提交请求的 Web/原生客户端中设置 Cookie。客户端在继续之前确认实际的会话和用户。现有会话不会被追溯撤销。 |
| 返回范围 | Web 保留经过校验的站内目标地址和可选的社交账号关联后续流程。只有在会话确认后才会执行返回跳转。邮件中不包含任何回调或登录 URL。 |
| 重发 | 每个邮箱、每个 IP 每 60 秒限一次请求。邮箱维度的占用记录持久化在 PostgreSQL 中，跨副本和进程重启都生效。IP 限流使用 Better Auth 现有的单进程内存存储；多副本部署还需要一个共享的 IP 限流器或边缘规则。 |
| 并发 | 一个基于数据库、时长 30 秒的操作租约，使同一邮箱的发送和验证串行执行。正常完成和 API 错误都会释放租约；租约过期可恢复被中断的进程。验证码的消费和尝试次数仍由 Better Auth 管理。 |

该策略适用于新的邮箱/密码账户，以及此前注册但邮箱尚未验证的用户。OAuth 保持其现有的 provider 身份规则。验证完成后，密码和社交登录仍是正常的登录方式。

Email OTP 插件还包含无密码登录、OTP 查询、密码重置和修改邮箱的端点。这些路由均已禁用。发送接口会拒绝 `email-verification` 以外的用途。未知邮箱和已验证邮箱收到的是同一条通用确认，既不发送验证码，也不创建会话。旧的链接式路由 `/send-verification-email` 和 `/verify-email` 返回 404；此替换方案必须与更新后的客户端一起发布。

## 配置 Cloudflare

为发件域名配置 Email Sending，并创建一个具有 `Email Sending: Edit` 权限的账户级 token。请按照官方的 [域名设置](https://developers.cloudflare.com/email-service/get-started/send-emails/) 和 [REST API 文档](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/) 操作。

```dotenv
CLOUDFLARE_ACCOUNT_ID=<32-character account ID>
CLOUDFLARE_EMAIL_API_TOKEN=<account-scoped email sending token>
EMAIL_FROM="Northwind <noreply@northwind.dev>"
```

`EMAIL_FROM` 接受纯地址或 `Display Name <address>` 形式。带名称的发件人使用 Cloudflare 的 `{ address, name }` 表示。在 dotenv 文件中请给名称加引号；格式错误和多行的地址会被拒绝。

本地开发读取 `apps/server/.env`。生产环境预配从 `.env.dokploy.local` 读取这组配置，并只注入到 API 中。更新这个本地文件不会更新已存在的 Dokploy 应用。发布前请在生产 API 中配置全部三个值；绝不要通过 `VITE_` 暴露它们。

部分配置会在初始化时失败。如果三个值都缺失，已验证账户和 OAuth 照常工作，而发送会返回 `503`，未验证的密码账户仍被拦截。`/readyz` 目前只检查核心应用依赖，不检查邮件配置；仅凭就绪检查不足以批准此功能发布。

传输层向 `https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send` 发送单收件人的纯文本和 HTML 邮件。它十秒超时，不跟随重定向，也不会自动重试。凭据、验证码、验证值和 provider 返回体永远不会被记录到日志。OTP 路由针对该请求覆盖了 Better Auth 1.7.2 会吞掉错误的后台执行器，使投递失败能传递到客户端。

## 客户端流程

1. 提交邮箱/密码注册或登录。
2. 注册返回 `token: null` 后，或登录返回 `EMAIL_NOT_VERIFIED` 时，以
   `{ "email": "user@example.com", "type": "email-verification" }` POST 到
   `/api/auth/email-otp/send-verification-otp`。
3. 准确展示投递的进行中、已接受或失败状态。发送只由用户操作触发，绝不由组件挂载或历史重放触发。投递失败后账户保持待验证状态，遇到 `429` 时遵循 `X-Retry-After`。
4. 从同一个客户端把 `{ "email": "user@example.com", "otp": "123456" }` 提交到
   `/api/auth/email-otp/verify-email`。验证码是字符串，因此前导零得以保留。输入框支持粘贴和 `one-time-code` 自动填充；原生端使用 `.textContentType(.oneTimeCode)`。
5. 成功后，通过现有的 Cookie 存储接收 `Set-Cookie`，然后调用 `get-session` 确认是预期的用户，再进入应用。不要把 JSON 中的会话 token 另存为一份凭据。
6. 为 `INVALID_OTP`、`OTP_EXPIRED`、`TOO_MANY_ATTEMPTS`、`429` 和投递失败提供重试操作。返回登录页时保留邮箱，清空密码/验证码。验证码绝不进入 URL、分析数据或持久化的 UI 存储。

Web 使用官方的 `emailOTPClient`，原生 `tips` 客户端则通过其串行化的账户传输层调用相同的 REST 端点。现有的 Cloudflare 发件配置是共用的。见 [Better Auth Email OTP](https://better-auth.com/docs/plugins/email-otp) 和 [原生 Cookie 认证](./native-ios-auth.zh-CN.md)。

## 验证与发布

处理器测试覆盖：会话拦截、原生 Origin 与 Cookie 建立、加密存储、过期、尝试次数、重放、轮换、通用响应、用途限制、外部 origin、投递失败以及两种限流。针对专用本地 `email_otp_test` PostgreSQL 数据库的测试覆盖并发发送、并发验证、尝试次数预算，以及 auth 实例重建后的冷却。CI 和生产工作流都会运行这些数据库测试。

2026-09-12 的本地验证通过了 426 个 monorepo 测试、三个专用 PostgreSQL 并发测试、全部工作区类型检查和生产构建。iOS 模拟器通过了 40 个认证/商店测试。使用隔离内存 API 的浏览器验收覆盖了：注册后不创建会话、六位数输入、错误验证码、真实的 60 秒重发倒计时、旧验证码失效、验证成功、Cookie 恢复以及回到原先的站内目标地址。模拟的投递失败保留了待验证账户；返回登录页时保留了邮箱、清空了密码并恢复了焦点。

最终提交检查重跑了 auth 包（57 个测试通过）、环境配置（八个）、Web（119 个），并在一个新的临时数据库容器中跑了全部三个 PostgreSQL 并发用例，随后删除了该容器。auth 类型检查和平台边界检查通过。常规的 auth 运行会跳过仅依赖数据库的测试套件；这些用例由单独的 PostgreSQL 运行覆盖。配套的 iOS 源码通过了 157 个单元测试和邮箱验证 UI 回归测试；StoreKit 交易测试和完整 UI 套件不在本次运行范围内。日志和原生端结果包位于 `/private/tmp/tips-commit-20260912/`。

Cloudflare 域名设置和实际投递已于 2026-09-12 检查。全部六条发件 DNS 记录均显示就绪；受限 token 处于激活状态，设置时的配额为每天 1,000 封邮件。一封来自 `Northwind <noreply@northwind.dev>` 的真实邮件送达了 Gmail，SPF、DKIM 和 DMARC 均通过。第二封邮件确认了之前的链接模板能够送达。这些测试没有部署应用。

在生产环境启用之前，先同步 API 凭据，部署 API 和更新后的客户端，然后用一个指定的未验证测试账户完整走一遍注册、真实收信、验证码验证、会话恢复和返回跳转。还要覆盖一个已存在的未验证账户、验证码过期和重发。本地 fixture 和此前的传输层测试都不能替代这项线上验收。

## IAP Sandbox 部署 — 2026-09-12

原生 Debug 应用指向 `https://iap-dev.northwind.dev`。此前运行的容器仍在使用 9 月 11 日的镜像：没有 OTP 策略，三项邮件设置也一项都没有注入。因此，本地源码和 fixture 测试并没有改变原生应用实际的注册行为。

API 现在运行的是 `e3e346e-email-otp-working-tree`，镜像为 `sha256:4cddaf3040b45f9b14528c8adcf2ebdb1384bdae0e353cee19ea78879d1f9d91`。三项现有的邮件设置已复制到私有 IAP 环境文件中，并在镜像和运行进程中完成校验。只重建了 API 容器；其认证 schema 和迁移日志与之前的镜像一致，因此不需要数据库迁移。Sandbox 数据库和 Tunnel 继续沿用。之前的镜像在本地保留为 `northwind-iap-dev-api:pre-email-verification-20260912`。

切换之前，18 个针对性的服务端测试通过，其中包括三个 PostgreSQL 并发测试，auth 包类型检查也通过。随后十项公网端点检查通过：已部署的构建、auth 健康检查、OTP 路由校验、发送路由校验、注册不创建会话、拦截未验证的密码登录、空会话、对携带 Cookie 的请求拒绝外部 origin、现有的 App Store 认证，以及删除临时验收账户。不带 Cookie 的 OTP 请求仍需有效验证码；Better Auth 的通用 origin 中间件只校验携带 Cookie 的请求，因此 CSRF 探测中带了一个无效 Cookie。证据位于 `/private/tmp/tips-email-deploy-20260912/live-checks.json`。

自动化部署检查期间没有发送真实的验证邮件。用户随后于 2026-09-12 确认邮箱验证通过；这被记录为对验证流程的手动验收，与上述自动化检查分开记录。此次部署不会启用独立的生产环境。
