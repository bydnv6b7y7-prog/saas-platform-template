import { describe, expect, it } from "bun:test";
import { EventType } from "@ag-ui/core";
import {
  AgentRunner,
  supportsLocalThreadEndpoints,
} from "@copilotkit/runtime/v2";
import { EMPTY } from "rxjs";

import {
  assistantRunQuotaContext,
  copilotUserContext,
  UserScopedAgentRunner,
} from "./user-scoped-runner";

type RunRequest = Parameters<AgentRunner["run"]>[0];
type ConnectRequest = Parameters<AgentRunner["connect"]>[0];
type IsRunningRequest = Parameters<AgentRunner["isRunning"]>[0];
type StopRequest = Parameters<AgentRunner["stop"]>[0];

function createDelegate() {
  const seen = {
    run: [] as RunRequest[],
    connect: [] as ConnectRequest[],
    isRunning: [] as IsRunningRequest[],
    stop: [] as StopRequest[],
  };
  const marker = {};
  const delegate = {
    run(request: RunRequest) {
      seen.run.push(request);
      return marker;
    },
    connect(request: ConnectRequest) {
      seen.connect.push(request);
      return marker;
    },
    async isRunning(request: IsRunningRequest) {
      seen.isRunning.push(request);
      return true;
    },
    async stop(request: StopRequest) {
      seen.stop.push(request);
      return true;
    },
  } as unknown as AgentRunner;

  return { delegate, marker, seen };
}

const runRequest = {
  threadId: "visible-thread",
  input: { threadId: "visible-thread", runId: "run-1" },
} as RunRequest;

describe("UserScopedAgentRunner", () => {
  it("uses stable, distinct internal thread keys while preserving AG-UI input", async () => {
    const { delegate, marker, seen } = createDelegate();
    const runner = new UserScopedAgentRunner(delegate);

    const result = copilotUserContext.run("user-a", () => runner.run(runRequest));
    expect(result).toBe(marker as ReturnType<AgentRunner["run"]>);
    await copilotUserContext.run("user-a", () =>
      runner.isRunning({ threadId: runRequest.threadId }),
    );
    copilotUserContext.run("user-a", () =>
      runner.connect({ threadId: runRequest.threadId }),
    );
    await copilotUserContext.run("user-a", () =>
      runner.stop({ threadId: runRequest.threadId, runId: "run-1" }),
    );
    copilotUserContext.run("user-b", () => runner.run(runRequest));

    expect(seen.run[0]?.threadId).toBe(seen.isRunning[0]?.threadId);
    expect(seen.run[0]?.threadId).toBe(seen.connect[0]?.threadId);
    expect(seen.run[0]?.threadId).toBe(seen.stop[0]?.threadId);
    expect(seen.run[0]?.threadId).not.toBe(seen.run[1]?.threadId);
    expect(seen.run[0]?.threadId).not.toContain("user-a");
    expect(seen.run[0]?.input.threadId).toBe("visible-thread");
  });

  it("fails closed without authenticated request context", () => {
    const { delegate } = createDelegate();
    const runner = new UserScopedAgentRunner(delegate);

    expect(() => runner.run(runRequest)).toThrow(
      "Authenticated Copilot user context is required.",
    );
  });

  it("does not expose the delegate's process-global local thread endpoints", () => {
    const { delegate } = createDelegate();
    const runner = new UserScopedAgentRunner(delegate);

    expect(supportsLocalThreadEndpoints(runner)).toBe(false);
  });

  it("restores a reserved quota exactly once when AG-UI reports a failed run", async () => {
    let seenRequest: RunRequest | null = null;
    let refunds = 0;
    const delegate = {
      run(request: RunRequest) {
        seenRequest = request;
        return EMPTY;
      },
    } as unknown as AgentRunner;
    const agent = {
      agentId: "test-agent",
      runAgent: async (
        _input: unknown,
        subscriber: { onEvent: (input: unknown) => void },
      ) => {
        subscriber.onEvent({ event: { type: EventType.RUN_ERROR } });
      },
      abortRun: () => undefined,
    } as unknown as RunRequest["agent"];
    const request = { ...runRequest, agent } as RunRequest;
    const runner = new UserScopedAgentRunner(delegate);

    assistantRunQuotaContext.run(
      {
        refund: async () => {
          refunds += 1;
        },
      },
      () => copilotUserContext.run("user-a", () => runner.run(request)),
    );
    const wrappedAgent = (seenRequest as RunRequest | null)?.agent;
    expect(wrappedAgent).toBeDefined();
    await wrappedAgent!.runAgent(request.input, {
      onEvent: () => undefined,
    });
    await wrappedAgent!.runAgent(request.input, {
      onEvent: () => undefined,
    });

    expect(refunds).toBe(1);
  });

  it("restores a reserved quota when the user cancels a run", async () => {
    let seenRequest: RunRequest | null = null;
    let refunds = 0;
    const delegate = {
      run(request: RunRequest) {
        seenRequest = request;
        return EMPTY;
      },
    } as unknown as AgentRunner;
    const request = {
      ...runRequest,
      agent: {
        agentId: "test-agent",
        runAgent: async () => undefined,
        abortRun: () => undefined,
      },
    } as unknown as RunRequest;
    const runner = new UserScopedAgentRunner(delegate);

    assistantRunQuotaContext.run(
      {
        refund: async () => {
          refunds += 1;
        },
      },
      () => copilotUserContext.run("user-a", () => runner.run(request)),
    );
    const wrappedAgent = (seenRequest as RunRequest | null)?.agent;
    wrappedAgent!.abortRun();
    await Promise.resolve();
    expect(refunds).toBe(1);
    await wrappedAgent!.runAgent(request.input, {
      onEvent: () => undefined,
    });

    expect(refunds).toBe(1);
  });
});
