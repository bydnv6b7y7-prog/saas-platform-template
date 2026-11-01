# 示例：我的笔记

[English](example-notes.md) | **简体中文**

一个只基于平台能力构建的小而完整的功能，供阅读参考，之后再替换掉。

| 平台能力 | 示例中的使用位置 |
| --- | --- |
| 按用户隔离的数据与账户删除 | `packages/product/src/schema/notes.ts`：`note.user_id` 在删除账户时级联删除 |
| 对象存储，浏览器直传 | `packages/product/src/notes.ts` 注册了 `note-attachment` 用途（PNG/JPEG/PDF，5 MB，链接有效期 10 分钟）；`apps/web/src/product/notes/upload.ts` 先预留，再直接上传到存储桶，然后确认 |
| Free/Pro 配额 | 该用途的 `quota`：Free 保留 3 个附件，Pro 100 个；页面会显示用量和拒绝提示 |
| 清理 | 删除笔记时在同一事务中释放其附件；删除账户时附件变为孤立；每小时一次的清理任务会把这两类附件从存储中删除 |
| 助手，只读工具 | `apps/server/src/product/index.ts` 中的 `listNotes` 只读取当前登录用户的笔记（标题和摘要），并由 `apps/web/src/product/notes/assistant.tsx` 渲染为卡片 |
| 助手，执行前确认 | `createNote` 是一个浏览器端工具（`useHumanInTheLoop`）：只有用户点击保存时草稿才会被保存；它列在 `ASSISTANT_PAGE_TOOL_NAMES` 中，因此重放的对话线程永远不会再次保存 |
| 两端共用一份约定 | `packages/product/src/assistant-contracts.ts`；如果服务端结果在渲染端无法解析，`assistant-contracts.test.ts` 会失败 |
| 管理后台 | `/admin/notes`：只显示总数，从不显示笔记内容 |
| 分析 | `note_created`（`source`、`has_attachment`），在 `apps/web/src/product/analytics.ts` 中声明 |
| 端到端 | `packages/product/e2e.ts`：在 S3 替身中校验上传、配额拒绝、签名查看链接、删除时释放、工具卡片和确认；mock 模型以 DeepSeek/OpenAI 的 `tool_calls` 格式调用工具 |

浏览器上传需要存储桶的 CORS 规则：`bun run storage:cors`（本地）或 `bun run storage:cors --deploy`。

## 移除示例

1. 删除 `packages/product/src/notes.ts`、`packages/product/src/routers/notes.ts`、`packages/product/src/schema/notes.ts`、
   `apps/web/src/product/notes/`、`apps/web/src/routes/_auth/(product)/notes.tsx`、
   `apps/web/src/routes/admin/(product)/notes.tsx` 、本文件以及英文版 `example-notes.md`。
2. 运行 `bun run check-types`；每个错误都指向一行接入该示例的代码（router、schema 索引、助手约定和工具、导航、管理后台标签页、建议、`e2e.ts`）。删除这些行，以及 `apps/web/src/product/analytics.ts` 中的 `note_created` 事件。
3. `bun run db:generate` 会生成删除 `note` 的迁移。
