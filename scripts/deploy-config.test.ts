import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeEnvLines, parseDeployPolicy, setEnvFileValue } from "./deploy-config";

describe("deploy configuration helpers", () => {
  test("defaults to the strict production policy and rejects unknown values", () => {
    expect(parseDeployPolicy({})).toEqual({ stage: "production", required: new Set(["email"]) });
    expect(parseDeployPolicy({ DEPLOY_STAGE: "staging", REQUIRED_INTEGRATIONS: "email" }))
      .toEqual({ stage: "staging", required: new Set(["email"]) });
    expect(parseDeployPolicy({ REQUIRED_INTEGRATIONS: "" }).required.size).toBe(0);
    expect(() => parseDeployPolicy({ DEPLOY_STAGE: "prod" })).toThrow();
    expect(() => parseDeployPolicy({ REQUIRED_INTEGRATIONS: "email,sms" })).toThrow(/sms/);
  });

  test("worker overrides replace inherited keys instead of duplicating them", () => {
    expect(mergeEnvLines(["A=1", "INGEST_ENABLED=false", "B=2"], ["INGEST_ENABLED=true", "C=3"]))
      .toEqual(["A=1", "INGEST_ENABLED=true", "B=2", "C=3"]);
  });

  test("writes values back without touching other lines or interpreting replacement patterns", () => {
    const path = join(mkdtempSync(join(tmpdir(), "deploy-config-")), ".env");
    writeFileSync(path, "A=1\nSECRET=old\n");
    setEnvFileValue(path, "SECRET", "new$&value");
    setEnvFileValue(path, "ADDED", "x");
    expect(readFileSync(path, "utf8")).toBe("A=1\nSECRET=new$&value\nADDED=x\n");
    expect(() => setEnvFileValue(path, "BAD", "a\nb")).toThrow();
  });
});
