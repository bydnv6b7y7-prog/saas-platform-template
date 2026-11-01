import { AppStoreError } from "./errors";

/** Bounded admission; backpressure never builds an unbounded in-memory task queue. */
export function concurrencyGate(maximum: number) {
  let active = 0;
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= maximum) throw new AppStoreError("VERIFICATION_UNAVAILABLE");
    active++;
    try { return await work(); } finally { active--; }
  };
}
