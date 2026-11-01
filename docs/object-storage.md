# 对象存储：一个 bucket，按用途登记

所有上传共用一个 S3 兼容 bucket（生产用 Cloudflare R2，本地用 compose 里的 SeaweedFS），由 `R2_*` 四个变量整组开启。
客户端拿签名链接直传 bucket，服务只负责签名、核对、出示和删除，不经手文件内容。

## 1. 用途（`StoragePurpose`）

每种上传登记一次，写明它能是什么：

| 字段 | 含义 |
| --- | --- |
| `name` | key 的第一段：`<name>/<环境>/<yyyy-mm>/<id>.<ext>`，便于按用途做生命周期规则或清理 |
| `types` | 允许的 MIME 类型，各带文件头魔数（`IMAGE_TYPES` 提供 JPEG / PNG / PDF） |
| `maxBytes` | 单个文件上限 |
| `uploadSeconds` / `viewSeconds` | 上传链接与查看链接的有效期 |
| `quota`（仅用户上传） | Free / Pro 各自同时保留的文件数与总字节 |

签名覆盖 `Content-Type` 与 `Content-Length`：上传必须与申请时一致，否则存储直接 403。上传后服务用 `HEAD` 和前几个字节核对大小、类型和文件头，核对通过才算数。

## 2. 两种台账

| 台账 | 归属 | 用于 |
| --- | --- | --- |
| `app_feedback_screenshot` | iOS App 安装（匿名） | App 反馈截图，按安装与 IP 限流，见 [反馈与评分](./app-feedback-rating.md) |
| `stored_object` | 登录用户 | 产品里的附件、头像等，`packages/api/src/user-objects.ts` |

两者都是**先写行、后签名**：bucket 里任何可能存在的对象，都有一行负责删除它。

用户上传的生命周期：

1. `reserve`：检查类型、大小、该用户在该用途下的额度（按用户加锁，并发也不会超），写行，返回签名 PUT；
2. 浏览器直传 bucket；
3. `confirm`：核对字节，标记已确认；产品把这个 id 关联到自己的行；
4. `viewUrl`：只给本人、只给已确认的对象，返回短期签名 GET；
5. `release`：产品删除关联行时，在同一事务里调用；
6. 每小时清理：删除已释放的、账号已删除的（`user_id` 被外键置空）、以及一小时内未确认的对象和行。删除失败的行保留到下次。

产品接入只需三步：定义 `UserStoragePurpose`；在产品 router 挂 `createUploadRouter(purpose)`；删除关联行时调用 `userObjects.release(ids, transaction)`。

## 3. 浏览器直传需要 CORS

```bash
bun run storage:cors            # 本地：apps/server/.env 的 R2_* 与 CORS_ORIGIN
bun run storage:cors --deploy   # 生产：.env.dokploy.local 的 R2_* 与 VITE_WEB_URL
```

规则只放行 Web 域名的 `PUT` / `GET` / `HEAD` 和 `content-type` 头。只有对象读写权限的 R2 token 改不了 bucket 设置，
此时脚本会打印 JSON，粘贴到 Cloudflare → R2 → bucket → Settings → CORS policy 即可。

`bun run doctor [--deploy]` 会用 Web 域名发一次真实的预检请求来验证；`bun run e2e` 给本地 S3 替身写入同一套规则。

## 4. 凭据

token 只需该 bucket 的对象读写权限。`/readyz` 报告 `objectStorage.configured`（不影响就绪）；没有 bucket 时上传入口关闭，其他功能照常。
