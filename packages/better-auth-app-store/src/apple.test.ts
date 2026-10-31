import { expect, test } from "bun:test";
import { createPrivateKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { APIException, Environment, SignedDataVerifier, VerificationException, VerificationStatus } from "@apple/app-store-server-library";
import { appleError, createAppleGateway } from "./apple";
import type { AppStoreStore } from "./types";

const fixture = async (name: string) => Bun.file(new URL(`../test-fixtures/apple/${name}`, import.meta.url)).text();
const root = Buffer.from(await Bun.file(new URL("../test-fixtures/apple/testCA.der", import.meta.url)).arrayBuffer());
const verifier = (env = Environment.SANDBOX, bundle = "com.example", online = false) => new SignedDataVerifier([root], online, env, bundle, 1234);
test("Bun verifies real Apple SDK fixture chains and all three JWS message types", async () => {
  const v = verifier();
  expect((await v.verifyAndDecodeTransaction(await fixture("transactionInfo"))).environment).toBe("Sandbox");
  expect((await v.verifyAndDecodeRenewalInfo(await fixture("renewalInfo"))).environment).toBe("Sandbox");
  expect((await v.verifyAndDecodeNotification(await fixture("testNotification"))).notificationType).toBe("TEST");
});
test("real signature verification rejects tampering, missing x5c, wrong app and wrong environment", async () => {
  const signed = await fixture("transactionInfo"), parts = signed.trim().split(".");
  parts[1] = Buffer.from(JSON.stringify({ environment: "Sandbox", bundleId: "com.example", signedDate: 1672956154001 })).toString("base64url");
  await expect(verifier().verifyAndDecodeTransaction(parts.join("."))).rejects.toBeInstanceOf(VerificationException);
  await expect(verifier().verifyAndDecodeTransaction(await fixture("missingX5CHeaderClaim"))).rejects.toBeInstanceOf(VerificationException);
  await expect(verifier(Environment.PRODUCTION).verifyAndDecodeTransaction(signed)).rejects.toMatchObject({ status: VerificationStatus.INVALID_ENVIRONMENT });
  await expect(verifier(Environment.SANDBOX, "another.app").verifyAndDecodeTransaction(signed)).rejects.toMatchObject({ status: VerificationStatus.INVALID_APP_IDENTIFIER });
  // Historical certificates are expired now: live ingress must not fall back to offline verification.
  await expect(verifier(Environment.SANDBOX, "com.example", true).verifyAndDecodeTransaction(signed)).rejects.toBeInstanceOf(VerificationException);
});
test("plugin accepts verified historical TEST notices but rejects local-testing environment hints", async () => {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const gateway = createAppleGateway({
    apple: { bundleId: "com.example", appAppleId: 1234, issuerId: "fixture", keyId: "fixture", privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), rootCertificates: [root] },
    environments: ["Sandbox"], products: [{ productId: "monthly", subscriptionGroupId: "100", entitlement: "pro" }],
    store: {} as AppStoreStore, // No API/DB calls are permitted by these signature-only cases.
  });
  expect(await gateway.notification(await fixture("testNotification"), true)).toMatchObject({ type: "TEST", environment: "Sandbox" });
  for (const environment of ["Xcode", "LocalTesting", "Production", "sandbox"]) {
    const payload = Buffer.from(JSON.stringify({ environment })).toString("base64url");
    await expect(gateway.transaction(`e30.${payload}.AA`)).rejects.toMatchObject({ code: "INVALID_ENVIRONMENT" });
  }
});
test("production artifact includes the real G3 CA and Bun can export its public key", async () => {
  const cert = new X509Certificate(Buffer.from(await Bun.file(new URL("../certs/AppleRootCA-G3.cer", import.meta.url)).arrayBuffer()));
  expect(cert.ca).toBe(true);
  expect(cert.fingerprint256.replaceAll(":", "").toLowerCase()).toBe("63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179");
  expect(cert.publicKey.export({ type: "spki", format: "pem" }).toString()).toContain("BEGIN PUBLIC KEY");
  expect(() => createPrivateKey("bad key")).toThrow();
});
test("Apple errors distinguish retryable propagation/network failures from permanent input failures", () => {
  for (const code of [4040002, 4040004, 4040006]) expect(appleError(new APIException(404, code, "test")).retryable).toBe(true);
  expect(appleError(new APIException(404, 4040005, "test")).retryable).toBe(false);
  expect(appleError(new APIException(429, 4290000, "test")).retryable).toBe(true);
  expect(appleError(new APIException(403, 4030001, "upstream private diagnostic"))).toMatchObject({
    code: "VERIFICATION_UNAVAILABLE", appleCode: 4030001, appleHttpStatus: 403, retryable: false,
    message: "App Store verification is temporarily unavailable",
  });
  expect(appleError(new APIException(400, 4000185, "test")).code).toBe("UNSUPPORTED_PURCHASE");
  const network = new Error("transport"); network.name = "FetchError";
  expect(appleError(new VerificationException(VerificationStatus.VERIFICATION_FAILURE, network)).retryable).toBe(true);
  expect(appleError(new VerificationException(VerificationStatus.VERIFICATION_FAILURE)).retryable).toBe(false);
  expect(appleError(new VerificationException(VerificationStatus.INVALID_APP_IDENTIFIER))).toMatchObject({
    code: "INVALID_SIGNED_DATA", verificationStatus: VerificationStatus.INVALID_APP_IDENTIFIER, retryable: false,
  });
});
