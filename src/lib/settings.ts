import { AppError } from "../items/model";
import { isXPlan, planFromSubscription, planRank, type XPlan } from "./plan";
import { DEFAULT_TIME_ZONE, isTimeZone } from "./time";

export type Preferences = {
  timeZone: string;
  planOverride: XPlan | null;
};

type PreferenceRow = {
  time_zone: string | null;
  x_plan: string | null;
};

export async function readPreferences(env: Env): Promise<Preferences> {
  const row = await env.DB.prepare(
    "SELECT time_zone, x_plan FROM app_settings WHERE id = 1",
  ).first<PreferenceRow>();
  const timeZone =
    row?.time_zone && isTimeZone(row.time_zone)
      ? row.time_zone
      : DEFAULT_TIME_ZONE;
  const planOverride = row?.x_plan && isXPlan(row.x_plan) ? row.x_plan : null;
  return { timeZone, planOverride };
}

export function effectivePlan(
  planOverride: XPlan | null,
  subscriptionType: string | null,
): XPlan {
  const fromApi = planFromSubscription(subscriptionType);
  if (!planOverride) return fromApi ?? "none";
  if (!fromApi) return planOverride;
  return planRank(planOverride) > planRank(fromApi) ? fromApi : planOverride;
}

export async function savePreferences(
  env: Env,
  timeZone: string,
  planOverride: XPlan | null,
  subscriptionType: string | null,
): Promise<void> {
  if (!isTimeZone(timeZone)) {
    throw new AppError(422, "That time zone is not recognized.");
  }
  if (planOverride !== null && !isXPlan(planOverride)) {
    throw new AppError(422, "That X plan is not recognized.");
  }
  const fromApi = planFromSubscription(subscriptionType);
  if (planOverride && fromApi && planRank(planOverride) > planRank(fromApi)) {
    throw new AppError(
      422,
      "That plan is higher than the connected X account.",
    );
  }
  await env.DB.prepare(
    "UPDATE app_settings SET time_zone = ?, x_plan = ? WHERE id = 1",
  )
    .bind(timeZone, planOverride)
    .run();
}
