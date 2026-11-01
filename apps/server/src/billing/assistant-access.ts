import { getUserBillingStatus } from "@northwind/auth";
import { adminAccess } from "@northwind/auth/admin";
import type {
  AccessSource,
  AssistantPlan,
  AssistantUsageStatus,
} from "@northwind/billing";
import {
  privacyHash,
  readUsage,
  releaseUsage,
  reserveUsage,
  usageWindow,
  type UsageReservation,
} from "@northwind/api/usage";
import { readOperationalSettings } from "@northwind/api/operational-settings";
import type { OperationalSettings } from "@northwind/env/operational-settings";
import { env } from "@northwind/env/server";

const FIVE_MINUTES_MS = 5 * 60 * 1_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

type AssistantLimitConfig = Pick<
  OperationalSettings,
  | "assistantFreePer5Minutes"
  | "assistantFreePerDay"
  | "assistantProPer5Minutes"
  | "assistantProPerDay"
>;

export type AssistantAccess = {
  plan: AssistantPlan;
  accessSource: AccessSource;
  limits: {
    per5Minutes: number;
    perDay: number;
  };
};

export type AssistantPrincipal = {
  id: string;
  role?: string | null;
};

export type AssistantRunReservation = {
  windows: UsageReservation[];
};

export type AssistantRunDecision =
  | { allowed: true; reservation: AssistantRunReservation }
  | {
      allowed: false;
      reason: "burst" | "daily";
      resetAt: string;
    };

export function assistantAccessForPlan(
  plan: AssistantPlan,
  config: AssistantLimitConfig,
): AssistantAccess {
  return createAssistantAccess(
    plan,
    plan === "pro" ? "subscription" : "free",
    config,
  );
}

export function assistantAccessForAdmin(
  config: AssistantLimitConfig,
): AssistantAccess {
  return createAssistantAccess("pro", "admin", config);
}

function createAssistantAccess(
  plan: AssistantPlan,
  accessSource: AccessSource,
  config: AssistantLimitConfig,
): AssistantAccess {
  const pro = plan === "pro";
  return {
    plan,
    accessSource,
    limits: {
      per5Minutes: pro
        ? config.assistantProPer5Minutes
        : config.assistantFreePer5Minutes,
      perDay: pro
        ? config.assistantProPerDay
        : config.assistantFreePerDay,
    },
  };
}

export async function getAssistantAccess(
  principal: AssistantPrincipal,
  readStatus: typeof getUserBillingStatus = getUserBillingStatus,
  readSettings: () => ReturnType<typeof readOperationalSettings> = readOperationalSettings,
): Promise<AssistantAccess> {
  // Each request takes its own snapshot; an in-flight run keeps its reservation limits.
  const config = { ...(await readSettings()).values };
  if (adminAccess.allows(principal)) return assistantAccessForAdmin(config);

  const status = await readStatus(principal.id);
  return assistantAccessForPlan(
    status.subscription?.grantsAccess === true ? "pro" : "free",
    config,
  );
}

export async function reserveAssistantRun(
  userId: string,
  access: AssistantAccess,
  reserve: typeof reserveUsage = reserveUsage,
  release: typeof releaseUsage = releaseUsage,
): Promise<AssistantRunDecision> {
  const subjectHash = privacyHash(userId, env.BETTER_AUTH_SECRET);
  const now = Date.now();
  const burstWindow = usageWindow(FIVE_MINUTES_MS, now);
  const dailyWindow = usageWindow(ONE_DAY_MS, now);
  const burst = await reserve({
    subjectHash,
    action: "assistant_run",
    countLimit: access.limits.per5Minutes,
    costLimit: access.limits.per5Minutes,
    costUnits: 1,
    now,
    windowMs: FIVE_MINUTES_MS,
  });
  if (!burst) {
    return {
      allowed: false,
      reason: "burst",
      resetAt: burstWindow.resetAt.toISOString(),
    };
  }

  let daily: UsageReservation | null;
  try {
    daily = await reserve({
      subjectHash,
      action: "assistant_run",
      countLimit: access.limits.perDay,
      costLimit: access.limits.perDay,
      costUnits: 1,
      now,
      windowMs: ONE_DAY_MS,
    });
  } catch (error) {
    await release(burst).catch(() => undefined);
    throw error;
  }
  if (!daily) {
    await release(burst);
    return {
      allowed: false,
      reason: "daily",
      resetAt: dailyWindow.resetAt.toISOString(),
    };
  }

  return { allowed: true, reservation: { windows: [burst, daily] } };
}

export async function releaseAssistantRun(
  reservation: AssistantRunReservation,
  release: typeof releaseUsage = releaseUsage,
): Promise<void> {
  await Promise.all(reservation.windows.map((window) => release(window)));
}

export async function getAssistantUsage(
  userId: string,
  access: AssistantAccess,
  read: typeof readUsage = readUsage,
): Promise<Omit<AssistantUsageStatus, "configured">> {
  const subjectHash = privacyHash(userId, env.BETTER_AUTH_SECRET);
  const daily = await read({
    subjectHash,
    action: "assistant_run",
    countLimit: access.limits.perDay,
    windowMs: ONE_DAY_MS,
  });
  return {
    plan: access.plan,
    accessSource: access.accessSource,
    historyEnabled: true,
    limits: access.limits,
    daily: {
      used: daily.used,
      remaining: daily.remaining,
      resetAt: daily.resetAt.toISOString(),
    },
  };
}
