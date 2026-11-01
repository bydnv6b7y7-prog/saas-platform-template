# iOS app：反馈与评分

状态：服务端与 App 均已实现 · 2026-09-28。iOS App 按本文件的接口合同读取远程设置、提交反馈与截图。

## 1. 要做什么

- **评分**：App 在「用户确实在用、刚完成一件顺利的事」时调用系统评分弹窗（StoreKit `requestReview`）；「我的」里另有「给Northwind评分」，打开 App Store 写评价页。弹出规则有 App 内置默认值，可由后端下发覆盖。
- **反馈**：App 内原生表单（正文、可选一张截图、选填联系方式；类别由 App 按入口自动定，诊断信息自动附带并在表单上说明），提交到本服务，保存并邮件通知运营者；管理后台可查看、标记已处理。表单的开关、类别、字数上限、能否附截图、在哪些出错页面出现入口，同样有默认值并可下发。

## 2. 归属与不变量

| 概念 | 唯一来源 | 说明 |
| --- | --- | --- |
| 客户端配置的结构、上下界、默认值 | `packages/env/src/app-client-config.ts`（zod） | API、Admin 表单、App 的内置默认值都照此；App 端同名字段、同默认值 |
| 当前生效配置 | `app_client_config` 单行快照（带 `revision`）；没有行时用共享默认值 | 与 `runtime_settings` 同样的读取顺序与乐观锁；每次保存写 `app_client_config_audit` |
| 一条反馈 | `app_feedback` 行；截图对象在 R2，账目在 `app_feedback_screenshot` | 创建后正文不可修改；只有 `status`（`new` / `done`）和处理人可改 |
| 反馈提交者身份 | 请求里的 Better Auth 会话（可无）+ App 生成的 `installationId` | 不信任请求体里的用户 ID；未登录时 `user_id` 为空 |
| 限频 | 按 `installationId` 与 IP 摘要（`sha256(ip + BETTER_AUTH_SECRET)`）在数据库里计数 | 不保存原始 IP |

- App 拿不到配置、配置解析失败或字段未知时，一律用内置默认值或忽略未知字段，**永远不因配置问题禁用或崩溃**；`review.enabled = false` / `feedback.enabled = false` 是唯一的关闭方式。
- 反馈在数据库提交成功后才返回 201；邮件通知在提交之后尽力发送，失败只记日志，不影响返回，也不重试到重复发送。
- 截图不经过本服务：App 先向本服务申请一次上传，拿到只对一个对象键、限定 `image/jpeg`、10 分钟内有效的 R2 预签名 PUT 链接，直接上传到 R2；提交反馈时只带上传编号。服务端在接受前向 R2 核对对象存在、大小与登记一致且 ≤ 1 MB、开头是 JPEG 标记。只有管理员能通过 10 分钟有效的预签名 GET 链接查看。截图 180 天后删除（先删 R2 对象、再删账目），反馈正文保留。
- 对象键为 `app-feedback/<NODE_ENV>/<年-月>/<上传编号>.jpg`：多个环境共用一个 bucket 时按环境分开，可分别设置生命周期规则；各环境只删除自己账目里的对象。
- 每个上传过的对象都在 `app_feedback_screenshot` 里有一行账目，R2 里的对象只会通过账目删除：没被认领的上传 24 小时后删除；反馈被删除（例如账号删除级联）后，其截图在下一次清理（每小时）删除。
- 未配置 R2（`R2_*` 缺任一项）时，`/api/app/config` 下发的 `allowsScreenshot` 恒为 `false`，申请上传返回 403；其余功能不受影响。
- 诊断信息只含白名单字段（见 §3），服务端拒绝未知字段，不存设备标识以外的个人信息。

## 3. 接口合同

### `GET /api/app/config`（公开）

`Cache-Control: public, max-age=300`。响应：

```json
{
  "revision": 0,
  "review": {
    "enabled": true,
    "minDaysSinceInstall": 7,
    "minActiveDays": 3,
    "requiresWidgetOrActiveDays": true,
    "cooldownDays": 60,
    "oncePerVersion": true,
    "triggers": ["themeApplied", "readingClosed"],
    "delaySeconds": 1
  },
  "feedback": {
    "enabled": true,
    "categories": ["bug", "suggestion", "other"],
    "maxMessageLength": 1000,
    "allowsScreenshot": true,
    "contextualEntries": ["purchaseFailed", "widgetNotUpdating"]
  }
}
```

`triggers`、`categories`、`contextualEntries` 取值来自合同里的枚举，App 忽略它不认识的值。

### `POST /api/app/feedback`（公开，可带会话 Cookie）

请求体 `application/json`，总大小上限 1.5 MB：

```json
{
  "installationId": "UUID",
  "category": "bug",
  "message": "1…maxMessageLength 字",
  "contact": "可选，最多 120 字",
  "context": "可选：purchaseFailed | widgetNotUpdating",
  "diagnostics": {
    "appVersion": "1.4.0", "build": "123", "os": "iOS 27.0", "device": "iPhone18,1",
    "locale": "zh-Hans", "widgetFamilies": ["large"], "pro": false, "theme": "cinnabar"
  },
  "screenshotUploadId": "可选：下面上传接口返回的 uploadId，且已上传完成"
}
```

`diagnostics` 每个字段都可省略，但不接受白名单以外的字段。App 目前总是附带白名单全部字段。`category` 由 App 按入口选：出错页进入为 `bug`，其余为 `other`；后台设置里的类别决定 App 可以用哪些，被关掉的类别 App 会退而用其他允许的类别。

| 结果 | 状态码 | 响应 |
| --- | --- | --- |
| 已保存 | 201 | `{ "id": "UUID" }` |
| 字段不合法、超长；截图编号不存在、不属于该安装、已过期、已被使用，或 R2 里的对象缺失、大小不符、不是 JPEG | 400 | `{ "error": "invalid_feedback", "field": "…" }`（截图问题的 field 为 `screenshotUploadId`） |
| `feedback.enabled = false` | 403 | `{ "error": "feedback_disabled" }` |
| 超过限频（同一安装每小时 5 条、每天 20 条；同一 IP 每小时 20 条、每天 100 条，公司或学校网络常共用一个出口 IP） | 429 | `{ "error": "rate_limited" }`，带 `Retry-After` |
| 数据库不可用 | 503 | `{ "error": "unavailable" }` |

### `POST /api/app/feedback/uploads`（公开）

申请一次截图上传。请求体 `{ "installationId": "UUID", "byteLength": 1…1000000 }`。

| 结果 | 状态码 | 响应 |
| --- | --- | --- |
| 可以上传 | 201 | `{ "uploadId": "UUID", "method": "PUT", "url": "R2 预签名链接", "headers": { "Content-Type": "image/jpeg", "Content-Length": "…" }, "expiresAt": "ISO 时间" }` |
| 字段不合法 | 400 | `{ "error": "invalid_upload", "field": "…" }` |
| 反馈关闭、截图关闭或未配置 R2 | 403 | `{ "error": "screenshots_disabled" }` |
| 超过限频（同一安装每小时 10 次；同一 IP 每小时 40 次） | 429 | `{ "error": "rate_limited" }`，带 `Retry-After` |
| 数据库不可用 | 503 | `{ "error": "unavailable" }` |

App 用返回的 `method`、`url`、`headers` 原样上传（链接 10 分钟有效），再在 1 小时内提交反馈。上传编号只能被同一安装使用一次。签名锁定对象键、`Content-Type` 与 `Content-Length`，R2 实测会拒绝不符的上传；链接在有效期内可重复 PUT 同一对象（同类型、同长度），认领时再以 HEAD 与文件头核对一次。

### 管理员（tRPC，`adminProcedure`）

- `config.appClient.overview / update({ expectedRevision, values }) / history`：与 `config.operations` 相同的语义。
- `appFeedback.list({ status?, cursor?, limit })`（不含截图字节）、`appFeedback.detail({ id })`（截图以 10 分钟有效的 R2 预签名 GET 链接返回）、`appFeedback.setStatus({ id, status })`。
- Admin Web：`/admin/config` 新增「iOS app」区块；新增 `/admin/feedback` 列表与详情（`?id=` 即通知邮件里的链接）。
- 设置 `FEEDBACK_NOTIFY_EMAIL` 后，每条反馈保存后发一封摘要邮件。

## 4. 可能的失败方式（先于实现）

**服务端**
1. 配置表不存在或读取失败时，`/api/app/config` 返回 500，App 因此禁用功能。→ 读取失败返回 503，App 按内置默认值运行。
2. 两个管理员同时保存配置，后者覆盖前者。→ `expectedRevision` 乐观锁 + 事务锁。
3. 配置写入超出上下界的值（负冷却、0 字数上限）。→ 共享 zod 合同在 API 与表单两端校验。
4. 请求体过大导致内存压力；base64 解码后才发现超限。→ 先检查 `Content-Length` 与原始长度，再解码。
5. 伪造 `user_id`。→ 只取会话。
6. 限频按原始 IP 存储，泄露隐私；或代理下所有请求同一 IP 被误限。→ 取 `x-real-ip`（与 tRPC context 一致），存摘要；同时按安装计数。
7. 并发请求绕过限频计数。→ 计数与插入在同一事务内，按安装加事务级 advisory lock。
8. 邮件发送失败导致请求失败或重复插入。→ 提交后发送，失败只记日志。
9. 截图不是图片或是恶意文件。→ 接受前向 R2 读取前 3 字节校验 JPEG 头；上传链接签名锁定 `Content-Type: image/jpeg`；后台以 `<img>` 显示预签名链接。
10. 附件无限增长。→ 180 天清理；清理只删截图。

**截图存储（R2）**
20. 预签名链接泄露或被重放。→ 只对一个随机对象键、只允许 PUT、10 分钟过期；链接不含凭据；对象只有被本服务核对后才会与反馈关联。
21. 客户端申请后上传更大的文件或别的类型。→ 签名同时锁定 `Content-Type` 与 `Content-Length`（R2 是否强制长度以实测为准，见验收）；无论如何，认领前以 HEAD 核对大小与登记一致且 ≤ 1 MB，再读前 3 字节核对 JPEG。
22. 只申请、不提交，R2 里堆积孤儿对象。→ 每次申请先写账目再签名；未认领超过 24 小时的对象由清理删除；申请本身按安装和 IP 限频。
23. 同一上传编号被两条反馈认领，或被别的安装拿去用。→ 认领在提交事务内以 `feedback_id IS NULL` 条件更新，且要求安装一致。
24. 删除账号只删了数据库行，R2 里留下截图。→ 账目对反馈是 `ON DELETE SET NULL`；已认领又失去反馈的对象在下一次清理删除。
25. R2 暂时不可用。→ 申请上传不访问 R2（只签名），不受影响；提交时核对失败返回 503，App 保留内容可重试；清理失败的对象保留账目，下次重试。
26. 本地或 CI 没有 R2 凭据。→ 截图功能整体关闭并通过配置告诉 App；集成测试用内存替身，另有只在提供凭据时运行的真实 R2 测试。
27. 凭据写错导致每次都失败却没人发现。→ `/readyz` 报告 `objectStorage.configured`（不影响就绪）；真实 R2 测试覆盖签名、上传、核对、读取和删除。
11. 非管理员读取反馈或截图。→ 全部走 `adminProcedure`。
12. `/readyz` 未检查新表，迁移遗漏时服务仍报就绪。→ 就绪检查加入四张新表。

另：删除账号时，登录状态下提交的反馈随账号级联删除；未登录提交的反馈与任何账号无关，保留。

**App 端**
13. 首次启动、离线时没有配置 → 用内置默认值。
14. 评分弹窗在首次引导、购买、面板打开、出错后弹出。→ 只在指定时机、无面板时触发，冷却与版本限制在本机持久化。
15. 系统弹窗被系统抑制，本机却记为已弹。→ 记录的是「请求过」，冷却按请求时间算（系统本身也限每年 3 次）。
16. 反馈提交失败丢失用户写的内容。→ 草稿保留，失败提示可重试；429、403 给出明确文案。
17. 诊断信息包含用户不知情或不该发的内容。→ 只发白名单里的技术信息（不含读者写的、看的、存的内容），表单上一行说明，隐私页逐项列出。（早先的逐项勾选让人困惑，已去掉。）
18. 截图过大 → 客户端先压缩到 1 MB 以下再申请上传；上传失败或核对不通过时保留表单内容，提示可移除截图后发送。
19. 大字号、英文、深色模式下表单被截断或按钮点不到。

## 5. 验收（端到端）

- 服务端：`apps/server/src/app-client/app-client.integration.test.ts`，真实 PostgreSQL（专用库 `northwind_app_feedback_test`），经 Hono 应用发 HTTP 请求、经 tRPC 以管理员 / 普通用户 / 未登录身份调用；存储用内存替身，行为与下面实测的 R2 一致（只接受签名的类型与长度）。23 项覆盖上面 1–12、20–26 条：默认配置与缓存头、管理员保存与审计、并发保存冲突、越界设置、非管理员拒绝、合法提交与通知、通知失败、身份只取会话与账号删除级联、IP 只存摘要、各类 400、按设置生效的 400/403、没有 R2 时截图整体关闭、截图直传与一次认领、各种核对不通过（未上传、大小不符、不是 JPEG、别的安装、超过 1 小时）与 R2 不可用 503、两个请求抢同一上传只有一个成功、上传限频、清理（未认领 24 小时、账号删除后、180 天、删除失败保留账目待重试）、按安装与按 IP 的反馈限频、并发提交不越限、数据库不可用 503、后台分页与标记。每次运行把全部 HTTP 往来写到 `.tmp/app-feedback/integration-report.json`。

  ```bash
  docker exec northwind-postgres psql -U postgres -c 'CREATE DATABASE northwind_app_feedback_test'   # 一次
  APP_FEEDBACK_TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/northwind_app_feedback_test \
    SKIP_ENV_VALIDATION=1 bun test apps/server/src/app-client/app-client.integration.test.ts
  ```

  去掉按安装的事务锁后「并发提交」一项失败，证明该测试确实覆盖第 7 条。CI 在 `deploy.yml` 以同样方式运行。
- 真实 R2：`apps/server/src/app-client/r2-storage.integration.test.ts`，仅在 `APP_FEEDBACK_R2_TEST=1` 且 `R2_*` 已配置时运行（CI 没有凭据，不运行），在 `app-feedback-test/` 下写入并删除几个小对象：签名包含 `content-length;content-type;host`；长度不符、类型不符、改动路径的 PUT 均 403；过期链接 403；精确上传 200；HEAD、读文件头、签名 GET 正常；删除后 HEAD 为空、签名 GET 404，重复删除无害。2026-09-29 对 `multi-env-storage` 3 项通过。

  ```bash
  cd apps/server && APP_FEEDBACK_R2_TEST=1 SKIP_ENV_VALIDATION=1 bun test src/app-client/r2-storage.integration.test.ts
  ```
- 全链路（2026-09-29）：本机服务端（全新迁移的数据库、真实 R2）上，模拟器里的 App 附上一张 13.6 MB 的 3000×4000 图片提交反馈 → App 压缩为 1200×1600、893,778 字节的 JPEG → 申请上传 → 直传 R2 → 提交 → `app_feedback` 与已认领的 `app_feedback_screenshot` 行 → 管理员详情的 10 分钟签名链接取回同样 893,778 字节的 `image/jpeg`。
- `scripts/api-smoke.sh` 增加：公开配置可读且带缓存头、非法反馈与非法上传申请 400、三个新管理接口未登录 401、`/readyz` 报告 `objectStorage`。
- App：UI 测试用本地 HTTP 测试服务模拟两个接口，验证表单发出的请求体、失败重试、配置关闭时入口消失；评分通过分析事件日志断言「满足条件时请求了评分」「关闭后不再请求」。
