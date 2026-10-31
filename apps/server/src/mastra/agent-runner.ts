import { PostgresAgentRunner } from "./postgres-agent-runner";

/** Shared durable runner used by both AG-UI transport and thread lifecycle APIs. */
export const agUiAgentRunner = new PostgresAgentRunner();
