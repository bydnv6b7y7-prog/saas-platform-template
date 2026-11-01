# Mastra + CopilotKit assistant

**English** | [简体中文](ai-assistant.zh-CN.md)

> Status: Current (2026-09-01)
> This capability serves signed-in users and is independent of the paused Market/Finding batch jobs.

## Architecture

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

There is no second AI server. The existing Bun/Hono process owns the runtime, and the existing
PostgreSQL pool is shared with `PostgresStore`. CopilotKit uses its multi-route AG-UI transport;
the UI selects `app-store-assistant` explicitly.

### Conversation history contract

History has three deliberately separate responsibilities:

1. **Canonical conversation** — Mastra Memory owns the complete thread, messages, title, and
   thread-scoped working memory. This is the only history used as model memory.
2. **Bounded model context** — each model step receives at most the latest 16 messages and then a
   contiguous recent suffix capped by `ASSISTANT_CONTEXT_TOKEN_LIMIT` (32,000 by default). Full
   messages stay stored; stale tool payloads are filtered before token trimming.
3. **UI replay projection** — append-only AG-UI run/events reproduce streaming, tool, interrupt,
   and terminal states after reconnect. They are transport state, not an additional source of
   model memory.

This follows Mastra's [message-history model](https://mastra.ai/docs/memory/message-history) and
AG-UI's [event protocol](https://docs.ag-ui.com/concepts/events): durable messages answer “what was
said,” while ordered lifecycle events answer “how this run should be rendered and resumed.”

`resourceId` always comes from the Better Auth session, while working memory and AG-UI replay are
further isolated by thread. Semantic recall and cross-thread resource memory remain disabled.
Observational Memory is also intentionally disabled until measured long-thread failures justify
its extra model cost and summarization risk. Mastra model spans already record actual token usage,
so that decision can be based on traces rather than message-count guesses.

Deleting a conversation is a hard, owner-scoped lifecycle operation: the API first removes its
derived AG-UI runs/events (events cascade from runs), then calls Mastra `memory.deleteThread()` to
remove the canonical thread, messages, and working memory. Active runs return `409`; cleanup is
retryable if storage is temporarily unavailable. Archive is intentionally not aliased to delete—an
archive/recovery state will be added only when the product exposes a real recovery lifecycle.

Versions verified on 2026-08-30: Mastra Core 1.63.0, `@ag-ui/mastra` 1.1.2, and CopilotKit
1.69.2. The bridge's direct AG-UI peers are locked to Core/Client 0.0.58 because that is the API
version used to build 1.1.2.

## Implemented capabilities

- Full AG-UI bridge through `@ag-ui/mastra`: run, streamed text, tool, state, interrupt, stop, and
  reconnect lifecycles stay on CopilotKit's protocol-native multi-route transport. Internal
  reasoning is deliberately excluded from the product stream (see Security below).
- The signed-in Web Shell resolves Assistant Usage first and then lazy-loads `CopilotSidebar`.
  The user opens it from a contextual floating orb. Desktop width is 360–520px (420px default),
  resizable by pointer or keyboard and persisted locally; below 1100px the same surface is a
  full-screen dialog with focus trapping, Escape dismissal, and background inertness.
- On `/rankings`, the sidecar reuses the page's tRPC/React Query keys for latest or date-range
  evidence. Category, chart, device, storefront, exact UTC range, `dataAsOf`, freshness, 24h-baseline
  availability, historical coverage, and publication state are rendered in the context card and
  passed through `useAgentContext`, so the UI and agent receive one scope.
- Starter prompts adapt to the visible scope. `getLatestChart` handles latest/strict 24-hour
  questions and returns the requested Top N up to 100; `getDateRangeLeaderboard` handles an explicit
  inclusive UTC range up to 366 days, returns Top N up to 100, and rejects future dates;
  `getChartSnapshot` returns the latest complete point-in-time observation inside one requested UTC
  date when a daily aggregate lacks publishable coverage; `getAppRankingHistory` handles one app's
  observed trend window. Snapshot output is always labeled with its exact timestamp and is never
  presented as a full-day aggregate. Tool results keep full UI data, while `toModelOutput` projects
  compact, evidence-complete model input.
- A Mastra `ToolCallFilter` removes retired tool calls and prior-run skill payloads from
  model-facing history without changing stored messages or the thread UI. Current tool schemas
  always take precedence over names or arguments quoted in older turns, and internal validation
  details are not user-facing guidance.
- A Mastra `TokenLimiter` runs after that filter on every model step. It keeps a contiguous recent
  history suffix within the configured token budget, preventing one large tool result or a long
  multi-step thread from overrunning a provider context window.
- The base instructions contain only stable behavior and evidence rules. The conditional Mastra
  skill `app-store-ranking-methodology` supplies date-range-leaderboard methodology and the scope
  catalog only when that specialized knowledge is needed.
- `createRankingsBrief` calls Mastra Structured Output with a Zod schema; the Sidebar renders the
  validated result as generative UI. The server adds App IDs only after rank + normalized-name
  matching against source facts; chart rows and reliable brief observations link back to the
  correct Rankings/App scope.
- The visible run stage is reduced only from events for the current AG-UI run. Replayed history is
  ignored; backend tool work stays generically labeled because the adapter buffers tool events, while
  frontend navigation reports actual execution. The stage disappears on the first visible text or a
  matching terminal event. There are no timers, percentages, or synthetic progress states.
- Mastra Observability stores model/tool traces in PostgreSQL with a sensitive-data processor.
- Model selection supports native DeepSeek, the OpenRouter gateway, and the existing
  OpenAI-compatible path without extra provider SDKs or implicit failover.
- Completed and in-flight AG-UI events are append-only and replayable across reconnects or API
  instances. A renewable PostgreSQL lease permits one active run per thread, propagates stop, and
  terminalizes an expired process-owned run as interrupted.
- Every signed-in user can open the in-sidecar History drawer, page 20 owner-scoped Mastra threads
  at a time, restore the full AG-UI stream, or start a lazily created conversation. The first
  completed answer saves a normalized title from the first user message; no title model call is
  made.
- Working memory is scoped to the Mastra thread and owned by the authenticated Better Auth user.
  Analysis goals and conversation preferences therefore never enter another conversation;
  transient chart facts remain excluded.
- Application RequestContext keys are Zod-validated and typed. Transport-only values such as the
  AG-UI payload, authenticated resource id, and abort signal use raw infrastructure keys; client
  labels are canonicalized from server-owned scope ids before entering instructions.
- Access is resolved server-side as Admin, Stripe subscription, or Free. Admin accounts receive
  Pro limits without a synthetic subscription; subscribed accounts are authorized only from the
  webhook-synchronized projection. Each logical user request reserves its five-minute and UTC-day
  buckets before model spend and refunds both on failed handoff, cancellation, or failure. A verified
  frontend-tool follow-up continues that request without consuming a second quota unit.

## Security and product boundaries

- Every runtime request requires a valid Better Auth session. Public ranking reads stay public;
  model spend does not.
- Runner storage keys are non-reversible hashes namespaced by authenticated user. PostgreSQL leases
  serialize one run per thread, propagate stop requests across instances, and recover an unfinished
  stream after process loss. Generic local thread-listing and clearing endpoints are not exposed.
- Authorization, Cookie, and all `x-*` headers are denied at the model-forwarding boundary.
- DeepSeek thinking is disabled at the provider boundary. Reasoning/thinking AG-UI events from any
  provider are filtered before both browser delivery and chat-event persistence; verified product
  stages replace private chain-of-thought.
- CopilotKit anonymous telemetry is disabled; product traces stay in the configured Mastra store.
- Provider API keys come only from the API process environment. They never enter the product
  database, AG-UI state, Mastra RequestContext, trace metadata, logs, Web bundles, or responses.
- Client-facing generic memory proxy routes are disabled.
- `GET /api/assistant/threads`, `PATCH /api/assistant/threads/:threadId`, and
  `DELETE /api/assistant/threads/:threadId` require authentication, filter or validate Mastra
  `resourceId` against the session user, return 404 for a foreign thread, and expose only sanitized
  thread DTOs. Delete also clears the matching user-scoped AG-UI replay projection. Search and
  archive are not exposed.
- The agent reads current ranking facts but never writes Market, Finding, Trend, or Case data.
  Rank is not converted into downloads, revenue, retention, users, market share, or causation.

## Usage configuration

Free / Pro limits are maintained at Admin → Settings (`/admin/config`), with a persisted
snapshot and before/after audit history. New requests read the latest limits; running requests
keep their original reservation and existing usage is never reset by a settings change.
See [configuration ownership and migration](./configuration.md). Provider, model, context budget,
and credentials remain deployment configuration.

## Provider configuration

Provider choice, model id, and credential are server deployment configuration. There is no
in-product credential editor or runtime database override. Put the selected provider key in
Dokploy or another deployment secret store and inject it only into the API process:

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

`COPILOT_MODEL` also accepts the full Mastra id, such as `deepseek/deepseek-v4-flash` or
`openrouter/deepseek/deepseek-v4-flash`. Provider choice is explicit: credentials from another
provider are never used as fallback. Because this assistant uses tools and Structured Output, an
OpenRouter replacement model must support both capabilities. Check Mastra's current
[DeepSeek models](https://mastra.ai/models/providers/deepseek) and
[OpenRouter gateway](https://mastra.ai/models/gateways/openrouter) registries before changing it.

## Setup

1. Configure `COPILOT_MODEL_PROVIDER`, optional `COPILOT_MODEL`, and the matching credential in
   `apps/server/.env` or the Dokploy deployment secret.
2. Apply the reviewed database migrations, then the Mastra-owned schema:

   ```bash
   bun run db:migrate
   cd apps/server
   bun run mastra:migrate
   ```

For Dokploy, put the values in the ignored `.env.dokploy.local` deployment-secret file and rerun
`bun run scripts/dokploy-provision.ts`. Only the API container receives the selected provider key;
the migration, ingestion, and Web containers do not.

## Rotation

Create a new provider key, update the API deployment secret, redeploy the API, verify `/readyz`
and a real assistant request, then revoke the old key at the provider. Provider/model changes use
the same redeploy path. There is intentionally no hot database override or silent fallback.

The release migration runner creates the AG-UI event tables and then creates or updates the
Mastra-owned tables before the API deploy. Runtime storage uses `disableInit: true`, so the API
never performs DDL. `/readyz` requires both storage layers plus the selected model configuration;
its response reports only the non-secret provider and model ids.

## Operational checks

- `/internal/metrics` exposes `app_copilot_configured` without credential values.
- The CopilotKit runner uses the shared PostgreSQL pool; it does not create a SQLite file or make an
  API container stateful. In-flight events are persisted before lease completion so another API
  instance can replay them.
- Mastra shutdown is awaited before the shared PostgreSQL pool closes, so buffered traces flush.
- `patches/@ag-ui%2Fmcp-apps-middleware@0.0.3.patch` only adds the missing ESM/CJS conditional
  export map required by Bun 1.4; remove it after the upstream package ships one.
- An unauthenticated `/api/copilotkit/*` request must return `401`.
- With the selected environment configuration missing or inconsistent, the runtime fails closed
  with `503` and does not expose credential material.
- `bun run product eval:agent` from `apps/server` runs opt-in live behavior checks with deterministic,
  side-effect-free tool fixtures for tool selection, arguments, data-before-navigation ordering,
  and the one-navigation limit. Deterministic trajectory checks remain in the normal test suite.

The deployment policy follows OWASP guidance on least privilege and secret lifecycle management:
[Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html).
