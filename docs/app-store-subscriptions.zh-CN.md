# App Store 内购（StoreKit 2）

[English](app-store-subscriptions.md) | **简体中文**

iOS App 内购订阅与网站 Stripe 订阅共用一套账号与权益判断，由 `packages/better-auth-app-store`
插件实现：App 购买后把签名交易交给服务端，服务端用 Apple 官方库验签、绑定账号、维护本地订阅投影，
并处理 App Store Server Notifications V2。插件的接口合同见 `packages/better-auth-app-store/README.md`。

## 1. 告诉平台你的 App 是谁

编辑 `packages/env/src/apple-application.ts`：

| 字段 | 来源 |
| --- | --- |
| `bundleId` | Xcode / App Store Connect 中 App 的 Bundle ID |
| `appAppleId` | App Store Connect → App 信息 → Apple ID（数字） |
| `subscriptionGroupId` | 订阅组 ID（不是单个订阅的 Apple ID） |
| `products` | 每个订阅商品的 Product ID、显示名与对应权益（如 `pro`） |

这些是公开身份，随代码发布；登录（原生 Apple 登录的 audience）与内购共用。

## 2. 凭据（只放部署环境）

在 App Store Connect → 用户与访问 → 集成 → App 内购买项目 创建 **In-App Purchase** 密钥（不要复用 Apple 登录密钥）：

```bash
APP_STORE_ISSUER_ID=…
APP_STORE_KEY_ID=…
APP_STORE_PRIVATE_KEY_BASE64=$(base64 < SubscriptionKey_XXXX.p8 | tr -d '\n')
APP_STORE_ENVIRONMENTS=Sandbox          # 上线后改为 Production（可写 Production,Sandbox 同时接收）
APP_STORE_ENABLED=true
```

缺任何一项而 `APP_STORE_ENABLED=true` 时 API 拒绝启动；没有 App 时保持 `APP_STORE_ENABLED=false`。
`bun run doctor` 会检查这一组是否完整。

## 3. 服务器通知

App Store Connect → App 信息 → App Store 服务器通知，Production 与 Sandbox 都填：

```
https://<API 域名>/api/auth/app-store/notifications
```

版本选 V2。保存后在 **Admin → Settings → App Store subscriptions** 用 Test notification 的「Send test notification」请求一次测试通知，下方收到通知即接通。
该面板同时显示凭据是否存在、各环境积压与最近处理结果（不显示密钥内容）。

## 4. 验收顺序

1. Sandbox：用 Sandbox Apple 账号在 TestFlight / 开发版购买，确认 Admin 中出现绑定与通知，网站侧权益同步为 Pro；
2. 续订、取消、退款各走一次，确认投影状态随通知变化；
3. 切到 `APP_STORE_ENVIRONMENTS=Production`，提交审核前再发一次测试通知。

后台任务按 `APP_STORE_REVERIFY_INTERVAL_SECONDS`（默认 900）重新核验活跃订阅、按
`APP_STORE_RECONCILE_INTERVAL_SECONDS`（默认 21600）补拉通知历史，一般不需要修改。
