import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { Environment, SignedDataVerifier, VerificationStatus } from "@apple/app-store-server-library";

const fixture = name => readFileSync(new URL(`../test-fixtures/apple/${name}`, import.meta.url));
const verifier = (environment, bundleId = "com.example") => new SignedDataVerifier([fixture("testCA.der")], false, environment, bundleId, 1234);
const sandbox = verifier(Environment.SANDBOX);
assert.equal((await sandbox.verifyAndDecodeTransaction(fixture("transactionInfo").toString())).environment, "Sandbox");
assert.equal((await sandbox.verifyAndDecodeRenewalInfo(fixture("renewalInfo").toString())).environment, "Sandbox");
assert.equal((await sandbox.verifyAndDecodeNotification(fixture("testNotification").toString())).notificationType, "TEST");
await assert.rejects(verifier(Environment.PRODUCTION).verifyAndDecodeTransaction(fixture("transactionInfo").toString()), error => error.status === VerificationStatus.INVALID_ENVIRONMENT);
await assert.rejects(verifier(Environment.SANDBOX, "another.app").verifyAndDecodeTransaction(fixture("transactionInfo").toString()), error => error.status === VerificationStatus.INVALID_APP_IDENTIFIER);
assert.throws(() => new SignedDataVerifier([fixture("testCA.der")], true, Environment.PRODUCTION, "com.example"));
const root = new X509Certificate(readFileSync(new URL("../certs/AppleRootCA-G3.cer", import.meta.url)));
assert.equal(root.ca, true);
assert.ok(root.publicKey.export({ type: "spki", format: "pem" }).includes("BEGIN PUBLIC KEY"));
console.log(JSON.stringify({ runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`, certificateChain: "passed", jws: "passed", identityBoundaries: "passed", bundledG3: "passed", liveOCSP: "requires Sandbox acceptance" }));
