# PostHog 分析与归因

[English](analytics.md) | **简体中文**

PostHog 是浏览器行为、获客归因、注册和订阅转化的分析目的地。浏览器端与服务端事件使用同一个项目 token，并在完成身份识别后使用同一个 Better Auth `user.id`。

## 事实来源不变量

| 关注点 | 事实来源 | 持久化与时机 |
| --- | --- | --- |
| 浏览器隐私策略 | 服务端根据可信的 `CF-IPCountry` 解析出的 `opt_in` / `opt_out` 策略；显式的部署模式和未知国家都失败关闭（fail closed）为 `opt_in` | 浏览器只收到策略类别，绝不会收到国家。严格国家列表可在运行时配置，且必须经过产品/法务审核。 |
| 浏览器偏好 | 本地存储中的 `northwind.analytics-consent.v1`，可被 GPC/DNT 覆盖 | 显式选择始终覆盖地区默认值。在 `opt_in` 下，`pending` 不发送任何数据；在 `opt_out` 下，`pending` 允许采集。`denied` 和浏览器隐私信号始终不发送任何数据。撤回同意会停止采集并清除 PostHog 浏览器身份。 |
| 匿名获客 | `posthog-js` 浏览器身份 | 只有在分析处于启用状态且尚未认证时，UTM/referrer 属性才会持久化在 PostHog 浏览器存储中。禁用期间收集的活动既不会发送，之后也不会补发。 |
| 大致地理位置 | 浏览器请求可能由 PostHog 补充地理信息；服务端事件设置 `disableGeoip: true`；由 PostHog 项目负责丢弃原始 IP | 派生出的浏览器地理信息可保留用于分析，但原始客户端地址必须在摄取时丢弃。开启丢弃只对此后生效，不会删除历史 IP 数据。 |
| 账号身份 | Better Auth `user.id` | `identify(user.id)` 合并登录前的浏览器活动；登出时调用 `reset()`。邮箱绝不作为 distinct ID。 |
| 注册 | Better Auth 用户创建数据库 hook | `user_signed_up` 在邮箱注册和社交注册时由服务端发出一次。 |
| 结账意图 | 浏览器中的定价操作 | `billing_checkout_started` 表示已认证的客户端请求了 Hosted Checkout；它不是收入。 |
| 订阅激活 | 经 Better Auth 处理的、已验证的 Stripe webhook | `subscription_started` 只在 Stripe 确认订阅后发出。Stripe 事件时间和确定性的 UUID 使 webhook 重试具有幂等性。 |
| 取消 / 结束 | 经 Better Auth 处理的、已验证的 Stripe webhook | 计划中的取消与订阅实际结束保持为两个独立事件。 |

分析失败绝不会导致认证、账单投影或 Stripe webhook 处理失败。PostHog 是下游观察者，而不是授权或计费的权威来源。

## 事件契约

共享的类型契约位于 `packages/analytics/src/index.ts`。产品在自己的代码（`apps/web/src/product/analytics.ts`）中通过声明合并（declaration merging）向 `ProductAnalyticsEvents` 添加自己的事件，因此这些事件和平台事件一样带有类型，而平台无需为它们命名。

| 事件 | 归属方 | 重要属性 |
| --- | --- | --- |
| `user_signed_up` | 认证服务端 | `auth_method` |
| `assistant_opened` | Web | `source`、经过清理的 `path` |
| `billing_interval_selected` | Web | `billing_interval` |
| `billing_checkout_started` | Web | 套餐、周期、以美分计的 USD 金额 |
| `billing_checkout_failed` | Web | 有限的失败类别；绝不是原始错误信息 |
| `subscription_started` | Stripe webhook | 套餐、周期、状态、以最小货币单位计的目录价格、币种 |
| `subscription_cancel_scheduled` | Stripe webhook | 套餐、周期、状态 |
| `subscription_ended` | Stripe webhook | 套餐、周期、状态 |

当分析在生效的策略与用户偏好下处于启用状态时，浏览器会在路径变化时显式采集 `$pageview` 和活动（campaign）属性。页面离开事件和通用自动采集事件均被禁用，以共享的、带类型的事件契约取而代之。SDK 自动发出的 `$opt_in` 事件被抑制，因为技术上处于启用的采集状态并不一定意味着访客已明确同意。会话回放、异常采集、问卷、热力图、死点击采集、任意元素属性和页面文本均被禁用。每个事件发送之前，都会移除所有 URL 查询字符串、hash 和内嵌凭据，并对分享 token 路径进行脱敏。这也包括 PostHog 嵌套的 `$initial_person_info` URL 和 referrer 字段，而不仅仅是顶层的 URL 属性。浏览器事件有意允许 PostHog 在项目丢弃原始连接地址之前，根据该地址派生大致的地理属性。活动归因仍然有效，因为 SDK 会在事件清理器运行之前，将 UTM 值提取到专门的活动属性中。

浏览器端的选择控制的是可选的设备分析。服务端的注册事件和 Stripe 订阅生命周期事件独立地由权威的账号与计费系统生成，不使用任何浏览器存储。请在隐私政策中明确这一区别；不要把浏览器开关描述为账号范围的删除或抑制控制。

## 地区策略

`ANALYTICS_PRIVACY_MODE` 是 Web 进程的仅服务端运行时设置：

- `opt_in`（安全默认值）：在访客允许之前，分析保持关闭。
- `opt_out`：分析默认启用，GPC/DNT 和持久化的隐私控制可以将其禁用。
- `geo`：服务端读取 Cloudflare 的 `CF-IPCountry`。`ANALYTICS_OPT_IN_COUNTRIES` 中的国家使用 `opt_in`；其他所有有效国家使用 `opt_out`。缺失、`XX` 或格式错误的值使用 `opt_in`。

默认的严格列表为 EEA + 英国 + 瑞士 + 加拿大，这是一条保守的工程基线，而不是详尽的法律结论。`ANALYTICS_OPT_IN_COUNTRIES` 的变更由产品/法务负责。部分无效的覆盖值会被拒绝，而不是悄悄削弱严格列表；随后根加载器会回退到 `opt_in`。策略在每个加载的文档中解析一次；完整刷新会重新评估策略，而不会为每次客户端路由切换增加一次策略请求。只有在启用了 Cloudflare IP Geolocation、且源站只接受来自可信 Cloudflare 路径的 Web 流量时，生产环境才可以使用 `geo`；否则请使用 `opt_in`。响应按 `CF-IPCountry` 进行 Vary，PostHog 绝不会从该策略解析器收到国家值。

## 配置

在两个运行时中使用同一个 US Cloud 项目 token：

```dotenv
# apps/web/.env or Web image build arguments
VITE_POSTHOG_PROJECT_TOKEN=phc_xxx
VITE_POSTHOG_HOST=https://ingest.northwind.dev

# apps/server/.env or API runtime environment
POSTHOG_PROJECT_TOKEN=phc_xxx
POSTHOG_HOST=https://us.i.posthog.com
```

浏览器事件使用第一方 Cloudflare Worker 作为 `api_host`；SDK 保留 `ui_host=https://us.posthog.com`，以便链接、工具栏和回放工具仍与 US Cloud 项目关联。Worker 必须将可信的 Cloudflare 客户端地址作为 `X-Forwarded-For` 转发，使 PostHog 派生出的是用户的地理位置而非代理的地理位置；同时要剥离入站 cookie，并保留文档所述的 `/static/*`、`/array/*` 和 API 路由行为。服务端事件绕过 Worker，直接发往 US 摄取主机。两个运行时共享项目 token 和身份契约，但有意不共享摄取主机。

`list_price_minor` 是以该币种最小单位计的目录价格上下文；它不是已确认的收入。实际收入必须来自成功的支付来源，例如已支付的 Stripe 发票或 PostHog Stripe 数据源。

在本地开发和测试中，token 可以不设置。正式的生产发布在任一运行时的 token 或其预期主机缺失或无效时，必须在构建、配置下发或就绪校验阶段失败关闭；生产环境绝不能在分析被禁用的情况下悄悄上线。在配置正确的发布运行之后，SDK 加载错误、被拦截的浏览器请求、代理故障和 PostHog 宕机都不应阻塞，也绝不能中断产品流程。两个运行时使用同一个 `POSTHOG_PROJECT_TOKEN` 仓库 secret，`VITE_POSTHOG_HOST` 作为浏览器代理的仓库变量，`POSTHOG_HOST` 作为服务端直连摄取的仓库变量。在初始设置后以及每次轮换服务端 token 或主机后，都要运行 Dokploy provisioner；浏览器 token 或代理的变更需要重新构建 Web 镜像。生产冒烟检查通过就绪元数据验证 API 主机，通过 Web CSP 验证浏览器代理，而不会向 PostHog 发送合成事件。

在承接生产流量之前，产品/法务必须确认 PostHog 数据处理协议、所选的项目区域/摄取主机，以及任何所需的跨境传输保障措施。在 PostHog 项目设置中，开启 **Discard client IP data**，为浏览器事件保持 GeoIP 补充开启，并设置经批准的保留期限。浏览器代码有意允许 GeoIP 补充，以便 PostHog 在丢弃原始客户端地址之前派生出大致的国家、地区、城市和时区属性。服务端生成的事件保留 `disableGeoip: true`，因为其网络地址属于应用基础设施，而不是用户。数据主体删除请求必须包含以内部 Better Auth 用户 ID 为键的 PostHog person 及其关联事件。当 `POSTHOG_PERSONAL_API_KEY` 和 `POSTHOG_PROJECT_ID` 都已配置时，账号删除现在会自动安排这一步（尽力而为）；缺少它们时，person 删除步骤会被跳过并记录日志——请设置这两个变量以完整覆盖删除。

## 初始 PostHog 视图

在第一批生产事件到达后，配置：

1. `user_signed_up` 和 `subscription_started` 的转化目标。
2. 一个漏斗：定价页 `$pageview` → `billing_checkout_started` → `subscription_started`。
3. 按初始 UTM 来源、初始引荐域名、最新 UTM 来源、套餐和计费周期拆分的注册与订阅数据。
4. 一个基于已识别用户回访排行榜或打开 Northwind AI 的留存视图。

已连接的 PostHog 项目目前以 UTC 报告。在业务报告时区被明确更改之前，仪表盘的分桶保持使用 UTC。

官方参考：[JavaScript Web SDK](https://posthog.com/docs/libraries/js)、[Cloudflare reverse proxy](https://posthog.com/docs/advanced/proxy/cloudflare)、[在项目级别丢弃 IP 地址](https://posthog.com/docs/privacy/data-storage#discarding-ip-addresses-at-project-level)、[识别用户](https://posthog.com/docs/getting-started/identify-users)、[UTM 细分](https://posthog.com/docs/data/utm-segmentation)、[Node.js SDK](https://posthog.com/docs/libraries/node) 和[事件去重](https://posthog.com/docs/data/events#event-deduplication)。
