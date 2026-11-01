# 原生 iOS 认证

[English](native-ios-auth.md) | **简体中文**

更新于：2026-09-13。Better Auth 仍固定在 1.7.2。历史验证章节保留其记录日期当时所用的配置。

## 不变量

- Better Auth 负责身份和服务端会话。原生 iOS 使用一个长期存在的默认 URLSession，并以系统的 HTTPCookieStorage.shared 作为唯一的 Cookie 存储。它从不把客户端提供的 subject 当作身份，也不会在 Keychain 中保存 Cookie 副本。
- 同一个 auth 实例使用同一个账户数据库。资料/密码修改作用于共享账户。服务端通过 `POST /api/auth/account/delete` 提供自助删除账户（见 [删除账户](./account-deletion.zh-CN.md)）；原生应用内删除页面，或深链接到 Web 端的 `/_auth/account/delete` 页面，都可满足 App Store 审核指南 5.1.1(v)。
- Web 授权码客户端及其回调 URL 仍是 Web 登录的权威配置。原生 Google audience 需要配置好的 iOS client ID；原生 Apple 认证使用与计费相同的应用目录身份。
- Apple StoreKit 权益与 Northwind Stripe 计费仍是相互独立的产品权益。
- 自动化集成测试使用隔离的内存 Better Auth 实例，不带数据库钩子、Stripe、外发邮件或 PostHog。

## 协议

Web 和原生 iOS 都使用 Better Auth 默认的 Cookie 会话。URLSession 处理 Set-Cookie 并发送 Cookie 请求头；对这些端点，原生客户端既不读取 set-auth-token，也不发送 Authorization 请求头。为原型添加的 Bearer 插件已被移除。基于 Cookie 认证的原生写操作会在 Origin 请求头中带上 auth origin，从而保留现有的 CSRF 检查。服务端保留固定版本的默认值：会话有效期 7 天，1 天后即可续期。客户端在启动和回到前台时检查 get-session，不实现单独的 access/refresh token 对。

| 操作 | 端点 |
| --- | --- |
| 邮箱注册 | `POST /api/auth/sign-up/email`，携带 name、email 和 password |
| 邮箱登录 | `POST /api/auth/sign-in/email` |
| 原生 Apple/Google 登录 | `POST /api/auth/sign-in/social`，携带 provider 和 idToken |
| 恢复会话 | `GET /api/auth/get-session` |
| 资料 | `POST /api/auth/update-user` |
| 退出登录 | `POST /api/auth/sign-out` |
| 删除账户 | `POST /api/auth/account/delete`，携带 `{ "email": "<account email>" }` |

邮箱/密码登录现在要求先验证邮箱。注册返回 `token: null`，且不创建会话。注册之后，或登录返回错误码 `EMAIL_NOT_VERIFIED` 时，客户端以 `email` 和 `type: "email-verification"` 调用 `POST /api/auth/email-otp/send-verification-otp`，然后把 `email` 和六位数的 `otp` 提交到 `POST /api/auth/email-otp/verify-email`。验证码五分钟后过期，允许输错三次，60 秒后可重新发送。`503` 表示投递失败；`429` 会带上以秒为单位的 `X-Retry-After`。

验证成功会返回 `status`、`user` 和一个会话 token，同时向提交请求的客户端下发 `Set-Cookie`。原生应用使用其现有的系统 Cookie 存储，并通过 `get-session` 确认是同一用户；它不保存 JSON 中的 token。整个过程不涉及浏览器跳转。`tips` 客户端的账户页面负责处理待验证状态、`.oneTimeCode` 输入、重发冷却、错误和取消。见 [邮箱验证](./email-verification.zh-CN.md)。Web、API 和原生端的接入必须在发布前协调一致。密码重置仍处于禁用状态。服务端已启用删除账户：原生客户端把已登录用户的邮箱 POST 到 `/api/auth/account/delete`（服务端会对照会话校验），或链接到 Web 端的删除页面。

原生客户端复用一个基于 URLSessionConfiguration.default 的 Alamofire Session。Set-Cookie、持久化、过期和请求 Cookie 匹配都由系统处理；没有自定义的 Cookie 快照、属性重建或 refresh token 实现。登录后，应用用实际的 Cookie 调用 get-session，并将用户 ID 与登录响应核对，因此预先存在的 Cookie 无法替另一个响应身份完成认证。

完整的认证操作在 Swift actor 的挂起点之间串行执行。被取代的响应无法在下一个 auth 请求修改 Cookie 之后再完成；被取消的登录会先完成清理，下一个操作才开始。退出登录只移除匹配的 Better Auth Cookie，保留无关的 Cookie。启动/前台检查会合并执行，不打断正在进行的认证，保留资料草稿，并且在临时网络故障时不会主动清除有效的 Cookie。UserDefaults 只保存"上次登录方式"这一显示提示，从不保存认证凭据。应用会尝试删除旧格式的 Keychain 数据，但不读取也不迁移它们；原型需要重新登录一次。

标准 Cookie 名为 `better-auth.session_token`，生产环境 HTTPS 下为 `__Secure-better-auth.session_token`。Cookie 值仍是经过签名的服务端会话标识。浏览器和原生端的 Cookie 存储相互独立；共用这套协议并不会让两者自动共享登录会话。现有 Web `createAuthClient` 的行为依然有效。Cookie 按 host、path 和 Secure 属性划分作用域，而不是按 origin/端口：开发和生产要使用不同的 host。测试使用隔离的内存 Cookie jar；一个专门的 UI 测试让模拟器应用的真实系统 jar 对接回环 HTTP fixture，并验证进程重启后的持久化。

## 原生 provider 配置

Google：为现有 Web 客户端保留 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`。另外添加 `GOOGLE_IOS_CLIENT_ID`，它来自为 `com.example.app` 注册的 Google OAuth iOS 客户端。应用必须使用同一个 client ID 及其反转 URL scheme。服务端同时接受 Web 和 iOS 两个 audience；Web 授权码交换仍使用第一个客户端。

Apple：配置 `APPLE_CLIENT_ID`、`APPLE_TEAM_ID`、`APPLE_KEY_ID` 和 `APPLE_PRIVATE_KEY_BASE64`。原生 audience 由 [`APPLE_APPLICATION.bundleId`](../packages/env/src/apple-application.ts) 派生，目前为 `com.example.app`，与 App Store 计费共用。不再需要 `APPLE_APP_BUNDLE_IDENTIFIER`；如果仍保留旧值，它必须与目录一致，否则启动失败。即使计费被禁用，这条断言同样生效。仅做原生 iOS 登录时，用 App ID `com.example.app` 作为 `APPLE_CLIENT_ID`，不需要 Web Services ID。若 Web 与原生共用同一个 provider，则用 Web Services ID 作为 client ID；宿主会把目录中的 Bundle ID 追加为 audience。私钥和生成的 client secret 只留在服务端。删除账户时对 Apple 凭据做原生授权码交换/撤销，需要额外一套经过评审的生命周期流程；共享的删除端点本身已经可用。

provider 分组在缺失时保持禁用，并拒绝不完整的凭据。仅添加移动端 audience 并不会启用 provider。原生 App ID 客户端不能替代网站所需的 Services ID 和回跳 URL 注册。

## 现有服务端副作用与隐私

配置了 PostHog 时，现有的邮箱注册钩子会以服务端用户 ID 记录 `user_signed_up`。直接走原生 `/sign-in/social` 的流程目前不会被该钩子归类。原生 SDK 的退出（opt-out）并不会关闭服务端分析。现有的 Stripe 客户钩子以及会话 IP/user-agent 存储仍作用于这个共享服务；iOS 隐私披露必须涵盖这些服务端行为。

Dokploy provisioner 只有在父级 provider 分组完整时才转发可选的 Google 原生 audience，会校验单行取值，并把它放进 API 环境。Apple 身份来自共享目录。App Store 配置开关和独立的 App 内购买凭据记录在 [计费配置约定](./app-store-subscriptions.zh-CN.md) 中；它们不能替代 Sign in with Apple 凭据。此次配置治理变更不会预配或部署任何服务。

## 本地开发

iOS 模拟器可以通过 `http://localhost:3000` 访问 Mac 上的服务；而 iPhone 上的 localhost 指的是手机自己。Release 构建要求配置 HTTPS 的 auth origin。不要把服务端密钥、数据库 URL 或 OAuth client secret 放进应用里。

检查时，`/api/auth/ok` 返回 `{"ok":true}`，`/api/auth/providers` 返回 Google 和 GitHub。Apple 凭据和 Google iOS 客户端都不存在。本地数据库中有现有的产品数据；注册测试请使用隔离的内存 native-auth 测试实例。

## 验证（2026-09-08）

- `packages/auth`：**31 个测试通过**，包括邮箱 Cookie 注册/会话生命周期、签名与篡改拒绝、缺失/不受信任 Origin 的拒绝、默认 7 天/1 天续期策略、续期/过期、HTTPS Cookie 属性、拒绝未验证的原生 ID token 且不创建账户/会话，以及追加的 Google/Apple audience。fixture 显式启用了 Origin/CSRF 检查，因为 Better Auth 在其测试环境中默认会跳过它们。`bun run check-types` 通过（在受限工作区中，增量缓存被重定向到 `/tmp`）。
- 在此前的集成运行中，`packages/env` 通过了 5 个测试和类型检查，provisioner 通过了 `bun build --target=bun --packages=external`。这些未改动的配置在 Cookie 迁移期间没有重新测试；provisioner 未被执行或部署。
- 原生 iOS：**34 个账户/协议测试**和 **2 个隔离的账户 UI 回归测试**在 iOS 26.5 上通过。协议测试使用真实的回环 HTTP 来覆盖系统 Cookie 传输和登录后的身份匹配；TCA 测试覆盖前台状态转换。UI 测试同时覆盖 mock 账户流程，以及应用进程终止/重启后系统 Cookie 的持久化，随后退出登录并再次重启。App/Widget 的 Debug 构建和未签名的 arm64 Release 构建均以 iOS 17.0 部署目标通过。Release 排除了 Debug mock、HTTP fixture 配置和本地 StoreKit 文件。应用隐私披露包含账户收集和现有的服务端注册钩子，应用内文案现在描述的是系统会话存储。
- 运行中的 localhost 服务健康状态和 provider 发现以只读方式重新检查过。没有在现有产品数据库中注册用户，没有发起计费请求，也没有发送分析验收事件。
- 真实的 Google/Apple 授权、生产 HTTPS、重置/验证邮件投递、删除和 Apple 撤销仍有待相应的配置/实现。本地测试不等于生产验收。

## 评审与升级边界

当前评审覆盖固定版本 1.7.2 的服务端、原生 Cookie 客户端、邮箱/社交登录请求边界以及 Web 兼容性。CSRF/Origin 检查保持启用；原生身份使用内置 provider 的签名、issuer、audience、过期和 nonce 校验。Apple client secret 在服务端生成，应用永远拿不到 provider 的 client secret。邮件投递、原生应用内删除页面及 Apple token 撤销、真实的 Google/Apple 凭据仍是发布门槛；服务端的共享账户删除端点本身已经实现。

[1.7.3 版本](https://github.com/better-auth/better-auth/releases/tag/v1.7.3) 恢复了早先的账户 schema。本仓库的 Drizzle schema 和迁移 0009 使用的是 1.7.2 的非空 issuer 以及 issuer/accountId 唯一索引。升级需要协调 schema 清理并验证迁移；只改包版本是不够的。这次 Cookie 重构没有改动服务端运行时 schema 或数据库迁移。

参考：[Apple Cookie 存储](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/httpcookiestorage)、[Cookies](https://better-auth.com/docs/concepts/cookies)、[会话管理](https://better-auth.com/docs/concepts/session-management)、[Google](https://better-auth.com/docs/authentication/google)、[Apple](https://better-auth.com/docs/authentication/apple)。

## Apple 登录预检 — 2026-09-12

用户确认邮箱验证已通过，并要求接下来做原生 Apple 登录验收。连接的 iPhone 13 Pro 上已安装该应用。现有的本地真机构建及其 provisioning profile 都包含 `TEAMID1234.com.example.app` 的 Sign in with Apple entitlement。

最初的 localhost/公网预检返回 `{"providers":[]}`。用户随后提供了 Sign in with Apple 的 Key ID `R6GNJRD95S` 及其本地 `.p8` 路径。该密钥通过了本地 P-256 签名检查。私有 IAP 环境最初把 `com.example.app` 同时用作 App ID 客户端和原生 audience；这种纯原生流程不需要 Web Services ID。为加载配置，只重建了 API 容器；其镜像、数据库和 Tunnel 均保留。公网 provider 发现现在返回 `{"providers":["apple"]}`，无效的 ID token 会以 `401 INVALID_TOKEN` 被拒绝且不下发会话 Cookie，运行中的 API 可以访问 Apple 的 JWKS 端点。App 内购买的 SubscriptionKey 仍是单独的配置。

验证通过：31 个 iOS Cookie/协议测试；21 个后端配置与协议测试，共 116 个断言；auth 包类型检查。新增的 `packages/auth/src/apple-native.integration.test.ts` 加入十个用例，覆盖：不使用 Web Services ID 的原生 App ID 登录，带原生 audience 和 SHA-256 nonce 的有效 RSA 签名，中继邮箱，不带姓名的重复登录，关联到已验证邮箱的现有账户，会话恢复/退出登录，以及拒绝错误的签名、issuer、audience、过期时间或 nonce。只有外部 JWKS 响应被替换为临时的测试公钥：Better Auth 真实的校验器、处理器和内存适配器均原样运行。这些测试没有使用真实的 Apple 账户、邮件投递或计费操作。证据位于 `/private/tmp/tips-apple-login-20260912/`；`apple-live-checks.json` 记录了启用 provider 之后的四项公网检查。

用户随后确认 iPhone 上 Apple 登录通过，记为原生手动验收。重复登录和冷启动恢复没有单独确认。下一个验收目标是 Web 登录。

用户提供了已注册的 Web Services ID `com.northwind.dev`，它关联 Primary App ID `TEAMID1234.com.example.app`、域名 `iap-dev.northwind.dev`，以及 Return URL `https://iap-dev.northwind.dev/api/auth/callback/apple`。`APPLE_CLIENT_ID` 现在使用这个 Services ID，而 `APPLE_APP_BUNDLE_IDENTIFIER=com.example.app` 保留原生 audience。现有 API 镜像保留不变，重建了其容器以加载私有环境。一次 provider 配置检查确认了 Web client ID、原生 audience 和 client secret 签名均已就绪，且未暴露任何密钥。

浏览器入口和 API 现在共用 `https://iap-dev.northwind.dev`。Tunnel 将认证、tRPC 和健康检查端点路由到 API 容器，将 Web 页面通过 `host.docker.internal:3001` 路由到 Mac 上现有的 Vite 服务；其他 `/api` 和 `/internal` 路径仍被屏蔽。被忽略的 `apps/web/.env.local` 把 `VITE_SERVER_URL` 和 `VITE_WEB_URL` 都设为这个 HTTPS origin。Vite 显式允许了这个开发主机名。见 [Tunnel 配置](../infra/cloudflare/README.md)。

真实浏览器从网站的 Apple 按钮进入了 Apple 账户登录页，使用的是预期的 Services ID、Return URL 和 `form_post` 响应模式。五个 Web OAuth 消息/API URL 测试通过。`/login`、`/api/auth/ok` 和 Apple provider 发现的公网检查通过，而 `/internal/metrics` 和 `/.env` 返回 404。证据位于 `/private/tmp/tips-apple-login-20260912/web/public-route-checks.json`。用户随后反馈 Apple 能回跳到网站，但要刷新几次才显示登录状态。这一反馈促成了下面的首响应修复；修复后仍需对真实 Apple 流程重新检查。

### Web 首响应会话渲染

公共 shell 以前总把每个首响应渲染为未登录，并等待仅在浏览器端执行的会话查询，把 pending/error 状态都当作匿名用户。dev 入口还会经由 Tunnel 加载 Vite 模块。实时会话 API 返回 `Cache-Control: no-store`，不会被边缘缓存。

根 loader 现在用现有 API 校验传入请求的 Cookie，并只序列化用于显示的用户字段（`id`、`name`、`email`）。这次查询限定在请求范围内，绕过 Cookie 缓存，并使用 `disableRefresh=true`；浏览器端的 `useSession` 仍负责续期及其 `Set-Cookie` 响应。SSR 和 server function 的响应保持 private/no-store。初始用户桥接放在根部，在浏览器第一次检查后即被丢弃，后续路由切换也无法再次引入它。头部现在能区分加载中、可重试的 API 失败，以及已确认的匿名状态。

十个回归测试通过，包括真实的 Better Auth 签名 Cookie 读取与撤销、多用户同时在线的隔离、不序列化凭据，以及头部状态。完整的 Web 构建/类型检查通过。针对构建后 Web 服务器的隔离 HTTP 测试确认：已验证账户在第一份 HTML 中即出现且只读取一次会话，匿名/已撤销情况的响应正确，HTML 中没有会话 token，响应头为 private/no-store。证据：`/private/tmp/tips-apple-login-20260912/web/first-response-check.json` 和 `session-build.log`。其临时服务器和内存账户均已停止。本地 Web 环境在 SSR 中使用 `SERVER_URL=http://127.0.0.1:3000`，而浏览器请求仍走 HTTPS origin。


### 提交验证 — 2026-09-12

最终源码通过了 57 个 auth 包测试、八个环境测试以及全部 119 个 Web 测试。三个 PostgreSQL OTP 并发测试也在一个全新的、隔离的 `email_otp_test` 容器中通过，该容器随后被删除。auth 包的常规运行会跳过仅依赖数据库的测试套件；单独的数据库运行即为并发方面的证据。auth 类型检查和平台边界检查通过。上文描述的完整 Web 构建/类型检查和首份 HTML 检查覆盖的是同一实现。日志位于 `/private/tmp/tips-commit-20260912/`。

配套的 iOS 源码在 iOS 26.5 上通过了 157 个单元测试（148 个 Swift Testing 和九个 XCTest）以及邮箱验证 UI 回归测试。本次运行排除了 `SubscriptionStoreTests`，也没有重跑完整的 UI 套件。真实的邮箱验证和原生 Apple 登录已获用户确认；真实的 Web Apple 回调在首响应修复后仍需重新检查。
