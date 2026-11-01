import { describe, expect, test } from "bun:test";

import { createMigrationHealthPayload } from "./migration-health";

describe("createMigrationHealthPayload", () => {
  test("exposes the release SHA only after a successful migration", () => {
    expect(
      createMigrationHealthPayload({
        status: "complete",
        buildSha: "release-sha",
        log: "done",
      }),
    ).toEqual({
      status: "complete",
      sha: "release-sha",
      buildSha: "release-sha",
      log: "done",
    });
  });

  test("identifies a failed build without exposing a releasable SHA", () => {
    expect(
      createMigrationHealthPayload({
        status: "failed",
        buildSha: "failed-sha",
        log: "migration failed",
      }),
    ).toEqual({
      status: "failed",
      sha: "",
      buildSha: "failed-sha",
      log: "migration failed",
    });
  });
});
