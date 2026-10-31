# Engineering Rules

## Scope and Invariants

- Before implementing a cross-layer feature, define its source-of-truth invariants: ownership, persistence semantics, temporal validity, and return scope.
- Parse and validate user-controlled route parameters at the boundary. Reject invalid or future date ranges before they reach ranking, navigation, or data layers.
- Keep displayed run state aligned with actual execution state. Do not present buffered tool events, replayed history, or optimistic UI state as a new or completed run.
- Treat frontend tool results as transient unless the backend explicitly persists them. A `followUp: false` flow must not imply durable agent memory.
- Use one shared contract for concepts consumed across backend, runtime, and UI. Do not duplicate date, scope, ranking, or identity-enrichment rules in separate layers.

## Delivery Workflow

- When a change crosses backend, agent runtime, and frontend, begin with a short invariant map and split review by layer before broad implementation.
- Prefer evidence-first investigation: inspect runtime behavior, official framework documentation, and source contracts before proposing a fix.
- Land the smallest reversible change that proves the invariant, then add targeted coverage for the boundary and the user-visible state transition.
- Escalate contradictions between schema-valid input and product-valid context; schema validation alone is not sufficient.

## Review Checklist

- Verify ranked or filtered results cannot leak unpublished, out-of-scope, or future-dated records.
- Verify URL/state transitions preserve the same scope on navigation, detail, and return paths.
- Verify replayed conversation history cannot trigger side effects or be rendered as a fresh execution.
- Verify quota, focus restoration, loading copy, and form semantics are enforced in behavior, not only described in prompts or labels.
