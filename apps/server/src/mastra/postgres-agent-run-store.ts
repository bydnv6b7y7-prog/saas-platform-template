import { rawQuery } from "@northwind/db";
import type { BaseEvent } from "@ag-ui/client";

export type AgentRunStatus =
  | "running"
  | "finalizing"
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";

export type AgentRunRecord = {
  id: string;
  runId: string;
  ownerToken: string;
};

export type StartedAgentRun = AgentRunRecord & {
  parentRunId: string | null;
};

export type StoredAgentEvent = {
  id: string;
  sequence: number;
  event: BaseEvent;
};

export type AgentRunHeartbeat = {
  stopRequested: boolean;
};

export type DeleteAgentThreadHistoryResult = {
  active: boolean;
  deletedRunCount: number;
};

export interface AgentRunStore {
  claimExpiredRun(input: {
    threadId: string;
    ownerToken: string;
    leaseMs: number;
  }): Promise<AgentRunRecord | null>;
  startRun(input: {
    threadId: string;
    runId: string;
    agentId: string;
    ownerToken: string;
    leaseMs: number;
  }): Promise<StartedAgentRun | null>;
  appendEvent(input: {
    runRecordId: string;
    ownerToken: string;
    sequence: number;
    event: BaseEvent;
  }): Promise<boolean>;
  heartbeat(input: {
    runRecordId: string;
    ownerToken: string;
    leaseMs: number;
  }): Promise<AgentRunHeartbeat | null>;
  finishRun(input: {
    runRecordId: string;
    ownerToken: string;
    expectedStatus: "running" | "finalizing";
    status: Exclude<AgentRunStatus, "running" | "finalizing">;
  }): Promise<boolean>;
  requestStop(input: {
    threadId: string;
    runId?: string;
  }): Promise<{ runId: string } | null>;
  findActiveRun(threadId: string): Promise<{ runId: string } | null>;
  loadRunEvents(runRecordId: string): Promise<StoredAgentEvent[]>;
  loadThreadEvents(
    threadId: string,
    afterEventId?: string,
  ): Promise<StoredAgentEvent[]>;
  deleteThreadHistory(
    threadId: string,
  ): Promise<DeleteAgentThreadHistoryResult>;
}

type RawQuery = typeof rawQuery;

function decodeEvent(value: unknown): BaseEvent {
  const decoded = typeof value === "string" ? JSON.parse(value) : value;
  if (!decoded || typeof decoded !== "object") {
    throw new Error("Stored AG-UI event is invalid.");
  }
  return decoded as BaseEvent;
}

/**
 * PostgreSQL persistence for CopilotKit's AgentRunner contract.
 *
 * The caller supplies a user-scoped, non-reversible thread key. This store
 * never sees or persists authentication material. All schema changes are owned
 * by the reviewed database migrations; runtime requests perform DML only.
 */
export class PostgresAgentRunStore implements AgentRunStore {
  constructor(private readonly query: RawQuery = rawQuery) {}

  async claimExpiredRun(input: {
    threadId: string;
    ownerToken: string;
    leaseMs: number;
  }): Promise<AgentRunRecord | null> {
    const result = await this.query<{
      id: string;
      run_id: string;
      owner_token: string;
    }>(
      `UPDATE mastra.ag_ui_runs
          SET status = 'finalizing',
              owner_token = $2::uuid,
              stop_requested = false,
              lease_expires_at = CURRENT_TIMESTAMP + ($3::double precision * INTERVAL '1 millisecond'),
              updated_at = CURRENT_TIMESTAMP
        WHERE id = (
          SELECT id
            FROM mastra.ag_ui_runs
           WHERE thread_id = $1
             AND status IN ('running', 'finalizing')
             AND lease_expires_at <= CURRENT_TIMESTAMP
           ORDER BY id DESC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
      RETURNING id::text, run_id, owner_token::text`,
      [input.threadId, input.ownerToken, input.leaseMs],
    );
    const row = result.rows[0];
    return row
      ? { id: row.id, runId: row.run_id, ownerToken: row.owner_token }
      : null;
  }

  async startRun(input: {
    threadId: string;
    runId: string;
    agentId: string;
    ownerToken: string;
    leaseMs: number;
  }): Promise<StartedAgentRun | null> {
    const result = await this.query<{
      id: string;
      run_id: string;
      owner_token: string;
      parent_run_id: string | null;
    }>(
      `INSERT INTO mastra.ag_ui_runs (
         thread_id,
         run_id,
         parent_run_id,
         agent_id,
         status,
         owner_token,
         lease_expires_at
       )
       SELECT $1,
              $2,
              (
                SELECT run_id
                  FROM mastra.ag_ui_runs
                 WHERE thread_id = $1
                 ORDER BY id DESC
                 LIMIT 1
              ),
              $3,
              'running',
              $4::uuid,
              CURRENT_TIMESTAMP + ($5::double precision * INTERVAL '1 millisecond')
       ON CONFLICT DO NOTHING
       RETURNING id::text, run_id, owner_token::text, parent_run_id`,
      [
        input.threadId,
        input.runId,
        input.agentId,
        input.ownerToken,
        input.leaseMs,
      ],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          runId: row.run_id,
          ownerToken: row.owner_token,
          parentRunId: row.parent_run_id,
        }
      : null;
  }

  async appendEvent(input: {
    runRecordId: string;
    ownerToken: string;
    sequence: number;
    event: BaseEvent;
  }): Promise<boolean> {
    const result = await this.query<{ id: string }>(
      `INSERT INTO mastra.ag_ui_events (run_id, sequence, event)
       SELECT id, $3, $4::jsonb
         FROM mastra.ag_ui_runs
        WHERE id = $1::bigint
          AND owner_token = $2::uuid
          AND status IN ('running', 'finalizing')
       ON CONFLICT (run_id, sequence) DO NOTHING
       RETURNING id::text`,
      [
        input.runRecordId,
        input.ownerToken,
        input.sequence,
        JSON.stringify(input.event),
      ],
    );
    return result.rows.length === 1;
  }

  async heartbeat(input: {
    runRecordId: string;
    ownerToken: string;
    leaseMs: number;
  }): Promise<AgentRunHeartbeat | null> {
    const result = await this.query<{ stop_requested: boolean }>(
      `UPDATE mastra.ag_ui_runs
          SET lease_expires_at = CURRENT_TIMESTAMP + ($3::double precision * INTERVAL '1 millisecond'),
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1::bigint
          AND owner_token = $2::uuid
          AND status = 'running'
      RETURNING stop_requested`,
      [input.runRecordId, input.ownerToken, input.leaseMs],
    );
    const row = result.rows[0];
    return row ? { stopRequested: row.stop_requested } : null;
  }

  async finishRun(input: {
    runRecordId: string;
    ownerToken: string;
    expectedStatus: "running" | "finalizing";
    status: Exclude<AgentRunStatus, "running" | "finalizing">;
  }): Promise<boolean> {
    const result = await this.query<{ id: string }>(
      `UPDATE mastra.ag_ui_runs
          SET status = $4,
              stop_requested = false,
              completed_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1::bigint
          AND owner_token = $2::uuid
          AND status = $3
      RETURNING id::text`,
      [
        input.runRecordId,
        input.ownerToken,
        input.expectedStatus,
        input.status,
      ],
    );
    return result.rows.length === 1;
  }

  async requestStop(input: {
    threadId: string;
    runId?: string;
  }): Promise<{ runId: string } | null> {
    const result = await this.query<{ run_id: string }>(
      `UPDATE mastra.ag_ui_runs
          SET stop_requested = true,
              updated_at = CURRENT_TIMESTAMP
        WHERE thread_id = $1
          AND status = 'running'
          AND stop_requested = false
          AND lease_expires_at > CURRENT_TIMESTAMP
          AND ($2::text IS NULL OR run_id = $2)
      RETURNING run_id`,
      [input.threadId, input.runId ?? null],
    );
    const row = result.rows[0];
    return row ? { runId: row.run_id } : null;
  }

  async findActiveRun(threadId: string): Promise<{ runId: string } | null> {
    const result = await this.query<{ run_id: string }>(
      `SELECT run_id
         FROM mastra.ag_ui_runs
        WHERE thread_id = $1
          AND status IN ('running', 'finalizing')
          AND lease_expires_at > CURRENT_TIMESTAMP
        ORDER BY id DESC
        LIMIT 1`,
      [threadId],
    );
    const row = result.rows[0];
    return row ? { runId: row.run_id } : null;
  }

  async loadRunEvents(runRecordId: string): Promise<StoredAgentEvent[]> {
    const result = await this.query<{
      id: string;
      sequence: number;
      event: unknown;
    }>(
      `SELECT id::text, sequence, event
         FROM mastra.ag_ui_events
        WHERE run_id = $1::bigint
        ORDER BY sequence ASC`,
      [runRecordId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      sequence: row.sequence,
      event: decodeEvent(row.event),
    }));
  }

  async loadThreadEvents(
    threadId: string,
    afterEventId?: string,
  ): Promise<StoredAgentEvent[]> {
    const result = await this.query<{
      id: string;
      sequence: number;
      event: unknown;
    }>(
      `SELECT event_row.id::text, event_row.sequence, event_row.event
         FROM mastra.ag_ui_events AS event_row
         JOIN mastra.ag_ui_runs AS run_row ON run_row.id = event_row.run_id
        WHERE run_row.thread_id = $1
          AND ($2::bigint IS NULL OR event_row.id > $2::bigint)
        ORDER BY event_row.id ASC`,
      [threadId, afterEventId ?? null],
    );
    return result.rows.map((row) => ({
      id: row.id,
      sequence: row.sequence,
      event: decodeEvent(row.event),
    }));
  }

  async deleteThreadHistory(
    threadId: string,
  ): Promise<DeleteAgentThreadHistoryResult> {
    const result = await this.query<{
      active: boolean;
      deleted_run_count: number;
    }>(
      `WITH active_run AS (
         SELECT EXISTS (
           SELECT 1
             FROM mastra.ag_ui_runs
            WHERE thread_id = $1
              AND status IN ('running', 'finalizing')
              AND lease_expires_at > CURRENT_TIMESTAMP
         ) AS active
       ), deleted_runs AS (
         DELETE FROM mastra.ag_ui_runs AS run_row
          USING active_run
          WHERE run_row.thread_id = $1
            AND active_run.active = false
         RETURNING run_row.id
       )
       SELECT active_run.active,
              (SELECT COUNT(*)::integer FROM deleted_runs) AS deleted_run_count
         FROM active_run`,
      [threadId],
    );
    const row = result.rows[0];
    return {
      active: row?.active ?? false,
      deletedRunCount: row?.deleted_run_count ?? 0,
    };
  }
}
