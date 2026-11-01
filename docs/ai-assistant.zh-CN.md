# Mastra + CopilotKit 助手

[English](ai-assistant.md) | **简体中文**

> 状态：Current（2026-09-01）
> 该能力面向登录用户，并与暂停的 Market/Finding 批处理相互独立。

## 架构

```text
signed-in React user
  → floating Northwind AI orb
  → responsive CopilotKit Sidebar sidecar (multi-route client, credentials included)
  → existing Hono API /api/copilotkit/*
  → CopilotRuntime v2
  → @ag-ui/mastra local agent bridge
  → Mastra agent + tools + skills + thread-scoped working-memory state signals
  → existing ranking repository + selected Mastra model provider
  → PostgreSQL schema: mastra
      ├─ Mastra threads, messages, traces, and working memory
      └─ AG-UI runs and append-only protocol events
```

不存在第二个 AI 服务。运行时由现有的 Bun/Hono 进程承载，现有的 PostgreSQL 连接池与
`PostgresStore` 共用。CopilotKit 使用其多路由（multi-route）AG-UI 传输；UI 显式选择
`app-store-assistant`。

### 会话历史契约

历史承担三项刻意分离的职责：

1. **规范会话（canonical conversation）** —— Mastra Memory 持有完整的线程、消息、标题以及线程级
   working memory。这是唯一被用作模型记忆的历史。
2. **有界模型上下文** —— 每个模型步骤最多接收最近 16 条消息，再截取一段连续的近期后缀，其上限由
   `ASSISTANT_CONTEXT_TOKEN_LIMIT`（默认 32,000）决定。完整消息仍然保存；过时的工具负载会在
   token 裁剪之前被过滤掉。
3. **UI 回放投影** —— 只追加的 AG-UI run/事件在重连后重现流式输出、工具、中断和终止状态。它们是
   传输状态，而不是额外的模型记忆来源。

这遵循 Mastra 的[消息历史模型](https://mastra.ai/docs/memory/message-history)与 AG-UI 的
[事件协议](https://docs.ag-ui.com/concepts/events)：持久化的消息回答“说了什么”，而有序的生命周期
事件回答“这次 run 应当如何渲染和恢复”。

`resourceId` 始终来自 Better Auth 会话，而 working memory 和 AG-UI 回放还会进一步按线程隔离。语义召回
（semantic recall）与跨线程的 resource 记忆保持禁用。Observational Memory 同样被有意禁用，直到实测的
长线程失败足以证明其额外的模型成本与摘要风险是值得的。Mastra 的模型 span 已经记录了实际的 token 用量，
因此这一决策可以基于 trace，而不是基于消息数量的猜测。

删除会话是一项硬删除、限定于所有者的生命周期操作：API 先删除其派生的 AG-UI run/事件（事件随 run
级联删除），然后调用 Mastra `memory.deleteThread()` 删除规范线程、消息和 working memory。正在运行的
run 返回 `409`；如果存储暂时不可用，清理可以重试。归档（archive）有意不作为删除的别名——只有当产品
提供真正的恢复生命周期时，才会加入归档/恢复状态。

2026-08-30 验证的版本：Mastra Core 1.63.0、`@ag-ui/mastra` 1.1.2 和 CopilotKit 1.69.2。该桥接层直接
依赖的 AG-UI peer 锁定在 Core/Client 0.0.58，因为 1.1.2 正是基于该 API 版本构建的。

## 已实现的能力

- 通过 `@ag-ui/mastra` 实现完整的 AG-UI 桥接：run、流式文本、工具、状态、中断、停止和重连的生命周期
  都保留在 CopilotKit 协议原生的多路由传输上。内部推理被有意排除在产品流之外（见下文“安全”）。
- 已登录的 Web Shell 先解析 Assistant Usage，再懒加载 `CopilotSidebar`。用户通过一个上下文相关的
  悬浮球打开它。桌面端宽度为 360–520px（默认 420px），可通过指针或键盘调整并在本地持久化；在 1100px
  以下，同一界面变为全屏对话框，带有焦点捕获、Escape 关闭和背景 inert。
- 在 `/rankings` 上，sidecar 复用页面的 tRPC/React Query key 获取最新或日期区间的证据。品类、榜单、
  设备、店面、精确的 UTC 区间、`dataAsOf`、新鲜度、24h 基线可用性、历史覆盖率和发布状态都会渲染在
  上下文卡片中，并通过 `useAgentContext` 传入，因此 UI 与 agent 接收的是同一个范围（scope）。
- 起始提示（starter prompt）会根据可见范围自适应。`getLatestChart` 处理最新/严格 24 小时的问题，按
  请求返回最多 100 的 Top N；`getDateRangeLeaderboard` 处理最长 366 天的显式闭区间 UTC 范围，返回最多
  100 的 Top N，并拒绝未来日期；当日聚合缺少可发布的覆盖率时，`getChartSnapshot` 返回所请求的单个
  UTC 日期内最新的完整时点观测；`getAppRankingHistory` 处理单个 App 的观测趋势窗口。快照输出始终标注
  其精确时间戳，绝不会被呈现为全天聚合。工具结果保留完整的 UI 数据，而 `toModelOutput` 投影出紧凑且
  证据完整的模型输入。
- Mastra `ToolCallFilter` 从面向模型的历史中移除已退役的工具调用以及之前 run 的 skill 负载，而不改变
  已存储的消息或线程 UI。当前的工具 schema 始终优先于旧轮次中引用的名称或参数，内部校验细节也不会
  作为面向用户的指引。
- Mastra `TokenLimiter` 在每个模型步骤中于该过滤器之后运行。它在配置的 token 预算内保留一段连续的近期
  历史后缀，防止单个大型工具结果或冗长的多步骤线程撑爆提供商的上下文窗口。
- 基础指令只包含稳定的行为与证据规则。条件加载的 Mastra skill `app-store-ranking-methodology` 仅在需要
  该专门知识时，才提供日期区间排行榜的方法论和范围目录。
- `createRankingsBrief` 使用 Zod schema 调用 Mastra Structured Output；Sidebar 将校验后的结果渲染为
  生成式 UI。服务端仅在依据源事实完成排名 + 规范化名称匹配后才添加 App ID；榜单行和可靠的简报观测会
  链接回正确的 Rankings/App 范围。
- 可见的运行阶段只从当前 AG-UI run 的事件中归约得出。回放的历史会被忽略；由于适配器会缓冲工具事件，
  后端工具工作保持通用标签，而前端导航上报的是实际执行情况。阶段提示在第一段可见文本或匹配的终止
  事件出现时消失。没有计时器、百分比或合成的进度状态。
- Mastra Observability 将模型/工具 trace 存储在 PostgreSQL 中，并配有敏感数据处理器。
- 模型选择支持原生 DeepSeek、OpenRouter 网关以及现有的 OpenAI 兼容路径，无需额外的提供商 SDK，也没有
  隐式故障转移。
- 已完成和进行中的 AG-UI 事件都是只追加的，可在重连或跨 API 实例时回放。可续期的 PostgreSQL 租约保证
  每个线程只有一个活跃 run，传播停止信号，并将过期的、由进程持有的 run 终结为 interrupted。
- 每个已登录用户都可以打开 sidecar 内的 History 抽屉，每次分页加载 20 个属于自己的 Mastra 线程，恢复
  完整的 AG-UI 流，或开始一个延迟创建的会话。第一个完成的回答会根据第一条用户消息保存一个规范化的
  标题；不会调用模型生成标题。
- Working memory 的作用域是 Mastra 线程，归属已认证的 Better Auth 用户。因此分析目标和会话偏好绝不会
  进入另一个会话；临时的榜单事实仍被排除在外。
- 应用的 RequestContext key 经过 Zod 校验并带类型。AG-UI 负载、已认证的 resource id 和 abort signal
  等仅用于传输的值使用原始基础设施 key；客户端标签在进入指令之前，会根据服务端持有的范围 id 进行规范化。
- 访问权限在服务端解析为 Admin、Stripe 订阅或 Free。Admin 账号获得 Pro 限额，但不会生成合成的订阅；
  订阅账号仅依据 webhook 同步的投影进行授权。每个逻辑用户请求在产生模型开销之前预留其五分钟桶和
  UTC 日桶，并在交接失败、取消或失败时退还两者。经过验证的前端工具后续请求会延续该请求，而不会消耗
  第二个配额单位。

## 安全与产品边界

- 每个运行时请求都需要有效的 Better Auth 会话。公开的排名读取保持公开；模型开销则不公开。
- Runner 存储 key 是按已认证用户命名空间隔离的不可逆哈希。PostgreSQL 租约保证每个线程串行只有一个 run，
  跨实例传播停止请求，并在进程丢失后恢复未完成的流。通用的本地线程列表与清空端点不对外暴露。
- Authorization、Cookie 以及所有 `x-*` 请求头在模型转发边界处被拒绝。
- DeepSeek thinking 在提供商边界处被禁用。来自任何提供商的 reasoning/thinking AG-UI 事件，在投递到
  浏览器和持久化聊天事件之前都会被过滤；经过验证的产品阶段提示取代了私有的思维链。
- CopilotKit 匿名遥测已禁用；产品 trace 保留在配置的 Mastra 存储中。
- 提供商 API key 只来自 API 进程的环境变量。它们绝不会进入产品数据库、AG-UI 状态、Mastra
  RequestContext、trace 元数据、日志、Web bundle 或响应。
- 面向客户端的通用 memory 代理路由已禁用。
- `GET /api/assistant/threads`、`PATCH /api/assistant/threads/:threadId` 和
  `DELETE /api/assistant/threads/:threadId` 需要认证，会依据会话用户过滤或校验 Mastra `resourceId`，
  对他人的线程返回 404，并只暴露经过清理的线程 DTO。删除还会清除对应用户范围的 AG-UI 回放投影。
  搜索与归档不对外暴露。
- agent 读取当前的排名事实，但从不写入 Market、Finding、Trend 或 Case 数据。排名不会被换算成下载量、
  收入、留存、用户数、市场份额或因果关系。

## 用量配置

Free / Pro 限额在 Admin → Settings（`/admin/config`）中维护，带有持久化快照和变更前/后的审计历史。新
请求读取最新的限额；正在运行的请求保留其原始预留，现有用量也绝不会因设置变更而被重置。参见
[配置归属与迁移](./configuration.zh-CN.md)。提供商、模型、上下文预算和凭据仍属于部署配置。

## 提供商配置

提供商选择、模型 id 和凭据属于服务端部署配置。产品内没有凭据编辑器，也没有运行时数据库覆盖。将所选
提供商的 key 放入 Dokploy 或其他部署密钥存储中，并只注入到 API 进程：

```dotenv
# Direct DeepSeek
COPILOT_MODEL_PROVIDER=deepseek
COPILOT_MODEL=deepseek-v4-flash
ASSISTANT_CONTEXT_TOKEN_LIMIT=32000
DEEPSEEK_API_KEY=sk-...

# Or OpenRouter; model is the upstream provider/model id
# COPILOT_MODEL_PROVIDER=openrouter
# COPILOT_MODEL=openai/gpt-5-mini
# OPENROUTER_API_KEY=sk-or-v1-...

# Or retain the existing OpenAI-compatible path
# COPILOT_MODEL_PROVIDER=openai-compatible
# COPILOT_MODEL=gpt-5-mini
# LLM_API_KEY=sk-...
# LLM_BASE_URL=https://example.com/v1
```

`COPILOT_MODEL` 也接受完整的 Mastra id，例如 `deepseek/deepseek-v4-flash` 或
`openrouter/deepseek/deepseek-v4-flash`。提供商选择是显式的：绝不会把另一个提供商的凭据用作回退。由于
本助手使用了工具和 Structured Output，替换用的 OpenRouter 模型必须同时支持这两项能力。更改之前，请先
查看 Mastra 当前的 [DeepSeek models](https://mastra.ai/models/providers/deepseek) 和
[OpenRouter gateway](https://mastra.ai/models/gateways/openrouter) 注册表。

## 安装配置

1. 在 `apps/server/.env` 或 Dokploy 部署密钥中配置 `COPILOT_MODEL_PROVIDER`、可选的 `COPILOT_MODEL`
   以及对应的凭据。
2. 先应用已审核的数据库迁移，再应用 Mastra 自有的 schema：

   ```bash
   bun run db:migrate
   cd apps/server
   bun run mastra:migrate
   ```

对于 Dokploy，将这些值放入被忽略的 `.env.dokploy.local` 部署密钥文件，然后重新运行
`bun run scripts/dokploy-provision.ts`。只有 API 容器会收到所选提供商的 key；迁移、数据采集和 Web 容器
都不会收到。

## 轮换

创建新的提供商 key，更新 API 部署密钥，重新部署 API，验证 `/readyz` 和一次真实的助手请求，然后在提供商
处吊销旧 key。更换提供商/模型也走同样的重新部署路径。有意不提供热数据库覆盖或静默回退。

发布迁移执行器会先创建 AG-UI 事件表，然后在 API 部署之前创建或更新 Mastra 自有的表。运行时存储使用
`disableInit: true`，因此 API 从不执行 DDL。`/readyz` 要求两个存储层以及所选的模型配置均就绪；其响应只
报告非机密的提供商 id 和模型 id。

## 运维检查

- `/internal/metrics` 暴露 `app_copilot_configured`，不包含凭据值。
- CopilotKit runner 使用共享的 PostgreSQL 连接池；它不会创建 SQLite 文件，也不会让 API 容器变得有状态。
  进行中的事件会在租约完成之前持久化，以便另一个 API 实例可以回放它们。
- 在共享 PostgreSQL 连接池关闭之前会等待 Mastra 关闭完成，从而确保缓冲的 trace 被刷出。
- `patches/@ag-ui%2Fmcp-apps-middleware@0.0.3.patch` 只补充了 Bun 1.4 所需、但上游缺失的 ESM/CJS 条件
  导出映射；上游包提供该映射后即可删除。
- 未认证的 `/api/copilotkit/*` 请求必须返回 `401`。
- 当所选的环境配置缺失或不一致时，运行时以 `503` 失败关闭（fail closed），且不会暴露任何凭据材料。
- 在 `apps/server` 中运行 `bun run product eval:agent`，会执行可选的线上行为检查，使用确定性、无副作用的
  工具 fixture，覆盖工具选择、参数、先取数据后导航的顺序以及单次导航上限。确定性的轨迹检查仍保留在常规
  测试套件中。

部署策略遵循 OWASP 关于最小权限和密钥生命周期管理的指南：
[Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)。
