import { weightedLength } from "./text";

// Longer posts are a subscriber feature. X documents the cap as 25,000
// characters for Basic, Premium, and Premium+ (About X Premium, help.x.com,
// captured 2026-10-10). The API reports the authenticated user's tier as
// subscription_type: None, Basic, Premium, or PremiumPlus.
export const X_PLANS = ["none", "basic", "premium", "premium_plus"] as const;
export type XPlan = (typeof X_PLANS)[number];

export type PostLimits = {
  standard: number;
  premium: number;
  showMoreAt: number;
};

export function isXPlan(value: string): value is XPlan {
  return (X_PLANS as readonly string[]).includes(value);
}

export function planFromSubscription(
  value: string | null | undefined,
): XPlan | null {
  switch (value) {
    case "None":
      return "none";
    case "Basic":
      return "basic";
    case "Premium":
      return "premium";
    case "PremiumPlus":
      return "premium_plus";
    default:
      return null;
  }
}

export function longPostsAllowed(plan: XPlan): boolean {
  return plan !== "none";
}

const PLAN_RANK: Record<XPlan, number> = {
  none: 0,
  basic: 1,
  premium: 2,
  premium_plus: 3,
};

export function planRank(plan: XPlan): number {
  return PLAN_RANK[plan];
}

export function postLimits(env: Env): PostLimits {
  return {
    standard: requiredLimit(env.X_STANDARD_POST_LIMIT),
    premium: requiredLimit(env.X_PREMIUM_POST_LIMIT),
    showMoreAt: requiredLimit(env.X_SHOW_MORE_AT),
  };
}

export function limitForPlan(limits: PostLimits, plan: XPlan): number {
  return longPostsAllowed(plan) ? limits.premium : limits.standard;
}

export function textOverCap(text: string, cap: number): boolean {
  return weightedLength(text) > cap;
}

function requiredLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("Post length config is not a positive integer.");
  }
  return parsed;
}
