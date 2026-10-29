import { AppError, type ItemRecord } from "../items/model";
import { creditsEmpty } from "../items/store";
import { limitForPlan, longPostsAllowed, postLimits } from "../lib/plan";
import { effectivePlan, readPreferences } from "../lib/settings";
import { zoneLabel } from "../lib/time";
import { postingGate } from "../posting/control";
import type { AuditRow } from "../ui/pages";
import type { Shell } from "../ui/shell";
import { publicAccount } from "../x/account";
import { wantsHtml } from "./parse";
import type { AppContext, FormMap } from "./types";

export const NOTICES: Record<string, string> = {
  saved: "Draft saved.",
  approved: "Approved. It will not post until you schedule it.",
  scheduled: "Scheduled.",
  unscheduled: "Unscheduled. It stays approved.",
  archived: "Archived.",
  deleted: "Deleted. It will not post.",
  disconnected: "X is disconnected.",
  imported: "Buffer drafts imported.",
  retry: "That post is queued. Only that post will be sent.",
  marked: "Marked as posted.",
  paused: "Posting is paused. Nothing will post.",
  restored: "Restored as a draft. Approve it again before it can post.",
  rescheduled: "Rescheduled.",
  preferences: "Preferences saved.",
};

export const OAUTH_ERRORS: Record<string, string> = {
  state: "The X connection attempt expired or did not match. Start it again.",
  scope: "X granted scopes outside the allowlist. The token was not stored.",
  oauth: "X did not connect. Nothing was stored.",
};

export function htmlWanted(c: AppContext): boolean {
  return wantsHtml(c.req.header("content-type"), c.req.header("accept"));
}

export function actorOf(c: AppContext): string {
  const identity = c.get("identity");
  return identity.kind === "human" ? identity.email : identity.tokenId;
}

export function redirectUri(env: Env): string {
  const origin = env.PUBLIC_ORIGIN.replace(/\/$/, "");
  return `${origin}/oauth/x/callback`;
}

export async function loadShell(
  c: AppContext,
  title: string,
  path: string,
): Promise<Shell> {
  const url = new URL(c.req.url);
  const identity = c.get("identity");
  const gate = await postingGate(c.env);
  const account = await publicAccount(c.env);
  const prefs = await readPreferences(c.env);
  const limits = postLimits(c.env);
  const plan = effectivePlan(prefs.planOverride, account.subscriptionType);
  const noticeKey = url.searchParams.get("notice") ?? "";
  const notice =
    noticeKey === "connected" && account.username
      ? `Connected as @${account.username}.`
      : (NOTICES[noticeKey] ?? null);
  return {
    title,
    path,
    csrf: c.get("csrf") ?? "",
    email: identity.kind === "human" ? identity.email : "",
    postingEnabled: gate.allowed,
    postingPaused: c.env.POSTING_ENABLED === "true" && gate.paused,
    showPause: c.env.POSTING_ENABLED === "true" && !gate.paused,
    longPosts: longPostsAllowed(plan),
    plan,
    planOverride: prefs.planOverride,
    postLimit: limitForPlan(limits, plan),
    standardLimit: limits.standard,
    premiumLimit: limits.premium,
    showMoreAt: limits.showMoreAt,
    timeZone: prefs.timeZone,
    timeZoneLabel: zoneLabel(Date.now(), prefs.timeZone),
    account,
    credits: await creditsEmpty(c.env),
    notice,
    banner: OAUTH_ERRORS[url.searchParams.get("error") ?? ""] ?? null,
  };
}

export function formOf(c: AppContext): FormMap {
  return c.get("form") ?? {};
}

export function idOf(c: AppContext): string {
  const id = c.req.param("id");
  if (!id) throw new AppError(404, "That draft is not here.");
  return id;
}

export function formText(form: FormMap, key: string): string {
  const value = form[key];
  return typeof value === "string" ? value : "";
}

export function editorState(item: ItemRecord | null) {
  if (!item) {
    return {
      kind: "post" as const,
      title: "",
      notes: "",
      segments: [{ text: "", media: [] }],
    };
  }
  return {
    kind: item.kind,
    title: item.title ?? "",
    notes: item.notes ?? "",
    segments: item.segments.map((segment) => ({
      text: segment.text,
      media: segment.media.map((media) => ({
        id: media.id,
        altText: media.altText,
        mime: media.mime,
      })),
    })),
  };
}

export async function listAudit(env: Env, itemId: string): Promise<AuditRow[]> {
  const rows = await env.DB.prepare(
    "SELECT actor, action, from_status, to_status, at FROM audit_log WHERE item_id = ? ORDER BY at ASC",
  )
    .bind(itemId)
    .all<{
      actor: string;
      action: string;
      from_status: string | null;
      to_status: string | null;
      at: number;
    }>();
  return (rows.results ?? []).map((row) => ({
    actor: row.actor,
    action: row.action,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    at: row.at,
  }));
}

export function jsonError(c: AppContext, error: AppError) {
  return c.json(
    { error: { message: error.message, fields: error.fields } },
    error.statusCode as 400,
  );
}
