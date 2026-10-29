import type { XPlan } from "../lib/plan";
import type { PublicAccount } from "../x/account";

export type Shell = {
  title: string;
  path: string;
  csrf: string;
  email: string;
  postingEnabled: boolean;
  postingPaused: boolean;
  showPause: boolean;
  longPosts: boolean;
  plan: XPlan;
  planOverride: XPlan | null;
  postLimit: number;
  standardLimit: number;
  premiumLimit: number;
  showMoreAt: number;
  timeZone: string;
  timeZoneLabel: string;
  account: PublicAccount;
  credits: boolean;
  notice: string | null;
  banner: string | null;
};

export type FieldErrors = Record<string, string>;
