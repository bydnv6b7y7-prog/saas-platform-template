import type { BetterAuthOptions } from "better-auth";
import { importPKCS8, SignJWT } from "jose";
import { createPrivateKey } from "node:crypto";

const socialProviderIds = ["google", "github", "apple"] as const;

export type SocialProviderId = (typeof socialProviderIds)[number];

type SocialProviders = NonNullable<BetterAuthOptions["socialProviders"]>;

export type SocialProviderEnvironment = {
  googleClientId?: string;
  googleIosClientId?: string;
  googleClientSecret?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  appleClientId?: string;
  appleAppBundleIdentifier?: string;
  appleTeamId?: string;
  appleKeyId?: string;
  applePrivateKeyBase64?: string;
};

function hasCompleteCredentials(
  provider: SocialProviderId,
  credentials: Record<string, string | undefined>,
): boolean {
  const configured = Object.entries(credentials).filter(([, value]) => Boolean(value));
  if (configured.length === 0) return false;
  if (configured.length === Object.keys(credentials).length) return true;

  const missing = Object.entries(credentials)
    .filter(([, value]) => !value)
    .map(([name]) => name)
    .join(", ");
  throw new Error(`Incomplete ${provider} OAuth configuration; missing ${missing}`);
}

function decodeApplePrivateKey(encoded: string): string {
  const privateKey = Buffer.from(encoded, "base64").toString("utf8").trim();
  if (
    !privateKey.startsWith("-----BEGIN PRIVATE KEY-----") ||
    !privateKey.endsWith("-----END PRIVATE KEY-----")
  ) {
    throw new Error("APPLE_PRIVATE_KEY_BASE64 must contain a base64-encoded PKCS#8 .p8 key");
  }

  try {
    const key = createPrivateKey(privateKey);
    if (
      key.asymmetricKeyType !== "ec" ||
      key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    ) {
      throw new Error("expected an EC P-256 key");
    }
  } catch (cause) {
    throw new Error("APPLE_PRIVATE_KEY_BASE64 must contain a valid Sign in with Apple .p8 key", {
      cause,
    });
  }

  return privateKey;
}

async function generateAppleClientSecret({
  clientId,
  teamId,
  keyId,
  privateKey,
}: {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
}): Promise<string> {
  const key = await importPKCS8(privateKey, "ES256");
  const now = Math.floor(Date.now() / 1_000);

  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: keyId })
    .setIssuer(teamId)
    .setSubject(clientId)
    .setAudience("https://appleid.apple.com")
    .setIssuedAt(now)
    .setExpirationTime(now + 180 * 24 * 60 * 60)
    .sign(key);
}

export function createSocialProviderConfiguration(environment: SocialProviderEnvironment): {
  providers: SocialProviders;
  enabledProviderIds: SocialProviderId[];
} {
  const providers: SocialProviders = {};
  const enabledProviderIds: SocialProviderId[] = [];

  if (
    hasCompleteCredentials("google", {
      GOOGLE_CLIENT_ID: environment.googleClientId,
      GOOGLE_CLIENT_SECRET: environment.googleClientSecret,
    })
  ) {
    providers.google = {
      // Keep the web client first for the existing authorization-code flow.
      clientId: environment.googleIosClientId
        ? [environment.googleClientId!, environment.googleIosClientId]
        : environment.googleClientId!,
      clientSecret: environment.googleClientSecret!,
      prompt: "select_account",
    };
    enabledProviderIds.push("google");
  }

  if (
    hasCompleteCredentials("github", {
      GITHUB_CLIENT_ID: environment.githubClientId,
      GITHUB_CLIENT_SECRET: environment.githubClientSecret,
    })
  ) {
    providers.github = {
      clientId: environment.githubClientId!,
      clientSecret: environment.githubClientSecret!,
      prompt: "select_account",
    };
    enabledProviderIds.push("github");
  }

  if (
    hasCompleteCredentials("apple", {
      APPLE_CLIENT_ID: environment.appleClientId,
      APPLE_TEAM_ID: environment.appleTeamId,
      APPLE_KEY_ID: environment.appleKeyId,
      APPLE_PRIVATE_KEY_BASE64: environment.applePrivateKeyBase64,
    })
  ) {
    const clientId = environment.appleClientId!;
    const teamId = environment.appleTeamId!;
    const keyId = environment.appleKeyId!;
    const privateKey = decodeApplePrivateKey(environment.applePrivateKeyBase64!);

    // Apple client secrets expire after at most six months. Better Auth resolves
    // async provider configuration per flow, so generate a fresh 180-day JWT.
    providers.apple = async () => ({
      clientId,
      // Accept both web and native ID tokens without replacing the web audience.
      ...(environment.appleAppBundleIdentifier
        ? { audience: [clientId, environment.appleAppBundleIdentifier] }
        : {}),
      clientSecret: await generateAppleClientSecret({ clientId, teamId, keyId, privateKey }),
    });
    enabledProviderIds.push("apple");
  }

  return { providers, enabledProviderIds };
}
