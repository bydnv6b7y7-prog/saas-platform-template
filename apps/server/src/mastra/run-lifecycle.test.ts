import { describe, expect, it, spyOn } from "bun:test";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { RequestContext } from "@mastra/core/request-context";
import { Observable, lastValueFrom, of, throwError, toArray } from "rxjs";

import {
  COPILOT_ABORT_SIGNAL_KEY,
  attachMastraRunLifecycle,
  bindMastraRunAbortSignal,
} from "./run-lifecycle";

type TestAgent = {
  run: (input: { runId: string }) => Observable<BaseEvent>;
  abortRun: () => void;
};

describe("Mastra AG-UI run lifecycle", () => {
  it("passes successful events through and installs a per-run abort signal", async () => {
    const requestContext = new RequestContext();
    let observedSignal: AbortSignal | undefined;
    const agent: TestAgent = {
      run: () => {
        observedSignal = requestContext.getRaw(COPILOT_ABORT_SIGNAL_KEY);
        return of({ type: EventType.RUN_FINISHED } as BaseEvent);
      },
      abortRun: () => {},
    };
    attachMastraRunLifecycle(agent, requestContext);

    const events = await lastValueFrom(
      agent.run({ runId: "run-a" }).pipe(toArray()),
    );

    expect(events.map((event) => event.type)).toEqual([EventType.RUN_FINISHED]);
    expect(observedSignal).toBeInstanceOf(AbortSignal);
  });

  it("turns adapter failures into a terminal RUN_ERROR without leaking details", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    const requestContext = new RequestContext();
    const agent: TestAgent = {
      run: () => throwError(() => new Error("provider-secret-diagnostic")),
      abortRun: () => {},
    };
    attachMastraRunLifecycle(agent, requestContext);

    try {
      const events = await lastValueFrom(
        agent.run({ runId: "run-a" }).pipe(toArray()),
      );

      expect(events).toEqual([
        {
          type: EventType.RUN_ERROR,
          message: "The assistant run did not complete.",
          code: "MASTRA_RUN_FAILED",
        },
      ]);
      expect(JSON.stringify(events)).not.toContain("provider-secret-diagnostic");
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog.mock.calls[0]?.[0]).not.toContain(
        "provider-secret-diagnostic",
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it("settles immediately on cancellation even when the source ignores abort", async () => {
    const requestContext = new RequestContext();
    let observedSignal: AbortSignal | undefined;
    const agent: TestAgent = {
      run: () =>
        new Observable<BaseEvent>((subscriber) => {
          observedSignal = requestContext.getRaw(COPILOT_ABORT_SIGNAL_KEY);
          void subscriber;
        }),
      abortRun: () => {},
    };
    attachMastraRunLifecycle(agent, requestContext);

    const eventsPromise = lastValueFrom(
      agent.run({ runId: "run-a" }).pipe(toArray()),
    );
    agent.abortRun();

    expect(await eventsPromise).toEqual([]);
    expect(observedSignal?.aborted).toBe(true);
  });

  it("injects the request-local signal into Mastra stream and resume calls", () => {
    const requestContext = new RequestContext();
    const controller = new AbortController();
    requestContext.setRaw(COPILOT_ABORT_SIGNAL_KEY, controller.signal);
    const observed: Array<Record<string, unknown> | undefined> = [];
    const mastraAgent = {
      id: "agent",
      stream(_messages: unknown, options?: Record<string, unknown>) {
        observed.push(options);
        return this.id;
      },
      resumeStream(_data: unknown, options?: Record<string, unknown>) {
        observed.push(options);
        return this.id;
      },
    };
    const bound = bindMastraRunAbortSignal(mastraAgent, requestContext);

    expect(bound.stream([], { runId: "run-a" })).toBe("agent");
    expect(bound.resumeStream({}, { runId: "run-b" })).toBe("agent");
    expect(observed).toEqual([
      { runId: "run-a", abortSignal: controller.signal },
      { runId: "run-b", abortSignal: controller.signal },
    ]);
  });
});
