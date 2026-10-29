import type { ItemRecord } from "../items/model";
import { getItem, rowChanges } from "../items/store";
import { log, scrub } from "../lib/log";
import { limitForPlan, postLimits, textOverCap } from "../lib/plan";
import { effectivePlan, readPreferences } from "../lib/settings";
import { dayKey } from "../lib/time";
import { ulid } from "../lib/ulid";
import {
  accessTokenForPosting,
  forceRefresh,
  publicAccount,
} from "../x/account";
import {
  createArticleDraft,
  createPost,
  publishArticle,
  setAltText,
  uploadMedia,
  type XFailure,
  type XResult,
  xFetchTimeoutMs,
} from "../x/client";
import {
  postsInWindow,
  recordPostedDay,
  releaseExpiredHolds,
  releaseSlot,
  reserveSlot,
} from "./cap";
import {
  clearPostingBlocked,
  markMissedDue,
  noteDisconnected,
  notePostingBlocked,
  postingBlockedSince,
  postingGate,
} from "./control";
import { maySendSegmentSql } from "./eligibility";
import { registerIdleSettle } from "./idle";

const DISPATCH_LEASE_MS = 120_000;

const UNKNOWN =
  "We don't know if this post went out. Check X before you send it again.";
const CREDITS = "X API credits are empty.";
const OVER_LIMIT =
  "Over the limit. Split it into a thread or make it an Article.";
const PARKED = "Connect the X account that approved this.";
const MEDIA_TTL_MS = 24 * 60 * 60 * 1000;

type Holder = { token: string; refreshed: boolean };

// One outcome for every way a claimed segment can stop. settle() is the
// only place that writes the attempt, the daily slot, the lease, and the
// status.
type Decision =
  | { type: "success"; postId: string }
  | { type: "rejected"; detail: string }
  | { type: "rate_limit"; resetAt: number | null }
  | { type: "ambiguous"; detail: string }
  | { type: "pause" }
  | { type: "lost_lease" };

type SettleCtx = {
  itemId: string;
  contentHash: string;
  segmentId: string;
  attemptId: string;
  leaseId: string;
  day: string;
  scheduledAt: number | null;
};

function leaseSpan(env: Env): number {
  // One X call can take the full timeout. Cover this call and the next
  // (an upload, then the post) and renew before each call.
  return xFetchTimeoutMs(env) * 2;
}

function failureDecision(failure: XFailure): Decision {
  switch (failure.type) {
    case "rate_limit":
      return { type: "rate_limit", resetAt: failure.resetAt };
    case "ambiguous":
      return { type: "ambiguous", detail: scrub(failure.detail) };
    case "credits":
      return { type: "rejected", detail: CREDITS };
    case "rejected":
      return { type: "rejected", detail: scrub(failure.detail) };
    case "unauthorized":
      return { type: "rejected", detail: "X rejected the token." };
    default: {
      const neverFailure: never = failure;
      return neverFailure;
    }
  }
}

function decideCall<T>(
  result: XResult<T> | Extract<Decision, { type: "pause" | "ambiguous" }>,
): Decision | { type: "ok"; value: T } {
  if (result.type === "pause") return result;
  if (result.type !== "ok") return failureDecision(result);
  return { type: "ok", value: result.value };
}

async function audit(
  env: Env,
  itemId: string,
  from: string,
  to: string,
  action: string,
  hash: string,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (id, item_id, actor, action, from_status, to_status, content_hash, at, detail_json)
     VALUES (?, ?, 'dispatcher', ?, ?, ?, ?, ?, NULL)`,
  )
    .bind(ulid(), itemId, action, from, to, hash, now)
    .run();
}

async function renewLease(
  env: Env,
  itemId: string,
  leaseId: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE items SET lease_until = ?
     WHERE id = ? AND lease_id = ? AND status = 'posting'`,
  )
    .bind(Date.now() + leaseSpan(env), itemId, leaseId)
    .run();
  return rowChanges(result) === 1;
}

async function gateStop(
  env: Env,
  itemId: string,
): Promise<Extract<Decision, { type: "pause" | "ambiguous" }> | null> {
  const gate = await postingGate(env);
  if (!gate.allowed) return { type: "pause" };
  const account = await publicAccount(env);
  const row = await env.DB.prepare(
    "SELECT approved_x_user_id FROM items WHERE id = ?",
  )
    .bind(itemId)
    .first<{ approved_x_user_id: string | null }>();
  if (
    !account.connected ||
    account.needsReconnect ||
    !account.userId ||
    row?.approved_x_user_id !== account.userId
  ) {
    return { type: "ambiguous", detail: UNKNOWN };
  }
  return null;
}

async function callX<T>(
  env: Env,
  itemId: string,
  holder: Holder,
  now: number,
  run: (token: string) => Promise<XResult<T>>,
): Promise<XResult<T> | Extract<Decision, { type: "pause" | "ambiguous" }>> {
  const blocked = await gateStop(env, itemId);
  if (blocked) return blocked;
  const first = await run(holder.token);
  if (first.type !== "unauthorized" || holder.refreshed) return first;
  holder.refreshed = true;
  const next = await forceRefresh(env, now);
  if (!next) return { type: "rejected", detail: "X rejected the token." };
  holder.token = next;
  // Pause, posting, or the connected account may have changed during the 401.
  const retry = await gateStop(env, itemId);
  if (retry) return retry;
  return run(holder.token);
}

async function claimSegment(
  env: Env,
  itemId: string,
  segmentId: string,
  leaseId: string,
  now: number,
): Promise<boolean> {
  // One statement. resend_segment_id lets the claim trigger insert the
  // attempt in this same UPDATE. A due row that misses any predicate is
  // left scheduled so the caller can park it.
  const result = await env.DB.prepare(
    `UPDATE items
     SET status = 'posting', lease_id = ?, lease_until = ?, resend_segment_id = ?,
         needs_reason = NULL, last_error = NULL, updated_at = ?
     WHERE id = ?
       AND status = 'scheduled'
       AND missed = 0
       AND pending_resolution IS NULL
       AND approved_hash = content_hash
       AND approved_x_user_id IS NOT NULL
       AND approved_x_user_id = (
         SELECT x_user_id FROM oauth_account WHERE id = 1 AND needs_reconnect = 0
       )
       AND scheduled_at <= ?
       AND ? = 'true'
       AND (SELECT posting_paused FROM app_settings WHERE id = 1) = 0
       AND ${maySendSegmentSql()}`,
  )
    .bind(
      leaseId,
      Math.max(now, Date.now()) + leaseSpan(env),
      segmentId,
      now,
      itemId,
      now,
      env.POSTING_ENABLED,
      segmentId,
      segmentId,
    )
    .run();
  if (rowChanges(result) < 1) return false;
  const row = await env.DB.prepare(
    "SELECT id FROM post_attempts WHERE id = ? AND segment_id = ?",
  )
    .bind(leaseId, segmentId)
    .first();
  return row !== null;
}

async function persistPostId(
  env: Env,
  segmentId: string,
  postId: string,
  now: number,
): Promise<void> {
  // The id is stored even when the lease was swept mid-request. Dropping
  // it is what let Send again post a second time.
  await env.DB.prepare(
    `UPDATE segments SET x_post_id = ?, posted_at = ?
     WHERE id = ? AND x_post_id IS NULL`,
  )
    .bind(postId, now, segmentId)
    .run();
}

async function resolveAttempt(
  env: Env,
  attemptId: string,
  outcome: "posted" | "rejected" | "not_posted" | "rate_limited",
  now: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE post_attempts SET outcome = ?, resolved_at = ?
     WHERE id = ? AND outcome IS NULL`,
  )
    .bind(outcome, now, attemptId)
    .run();
}

async function setItem(
  env: Env,
  ctx: SettleCtx,
  status: "posted" | "needs_you" | "scheduled",
  reason: "unknown" | "rejected" | null,
  lastError: string | null,
  now: number,
  scheduledAt: number | null,
  missed: number,
  keepLeaseUntil: boolean,
): Promise<void> {
  const postedAt = status === "posted" ? now : null;
  const result = await env.DB.prepare(
    `UPDATE items SET status = ?, needs_reason = ?, last_error = ?,
       scheduled_at = COALESCE(?, scheduled_at),
       lease_id = NULL,
       lease_until = CASE WHEN ? = 1 THEN lease_until ELSE NULL END,
       posted_at = COALESCE(?, posted_at),
       resend_segment_id = NULL,
       missed = ?,
       pending_resolution = NULL,
       updated_at = ?
     WHERE id = ? AND status IN ('posting', 'needs_you', 'scheduled')`,
  )
    .bind(
      status,
      reason,
      lastError,
      scheduledAt,
      keepLeaseUntil ? 1 : 0,
      postedAt,
      missed,
      now,
      ctx.itemId,
    )
    .run();
  if (rowChanges(result) === 1) {
    await audit(
      env,
      ctx.itemId,
      "posting",
      status,
      status,
      ctx.contentHash,
      now,
    );
  }
}

async function remainingSegments(env: Env, itemId: string): Promise<number> {
  const rest = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM segments WHERE item_id = ? AND x_post_id IS NULL",
  )
    .bind(itemId)
    .first<{ n: number }>();
  return rest?.n ?? 0;
}

async function settle(
  env: Env,
  ctx: SettleCtx,
  decision: Decision,
  now: number,
): Promise<string> {
  switch (decision.type) {
    case "success": {
      await persistPostId(env, ctx.segmentId, decision.postId, now);
      await resolveAttempt(env, ctx.attemptId, "posted", now);
      await recordPostedDay(env, ctx.segmentId, ctx.day);
      const rest = await remainingSegments(env, ctx.itemId);
      if (rest > 0) {
        await setItem(
          env,
          ctx,
          "scheduled",
          null,
          null,
          now,
          ctx.scheduledAt,
          0,
          false,
        );
        return "segment";
      }
      await setItem(env, ctx, "posted", null, null, now, null, 0, false);
      return "posted";
    }
    case "rejected": {
      await resolveAttempt(env, ctx.attemptId, "rejected", now);
      await releaseSlot(env, ctx.segmentId);
      await setItem(
        env,
        ctx,
        "needs_you",
        "rejected",
        decision.detail,
        now,
        null,
        0,
        false,
      );
      return "needs_you";
    }
    case "rate_limit": {
      const when =
        decision.resetAt && decision.resetAt > now
          ? decision.resetAt
          : now + 60_000;
      await resolveAttempt(env, ctx.attemptId, "rate_limited", now);
      await releaseSlot(env, ctx.segmentId);
      await setItem(
        env,
        ctx,
        "scheduled",
        null,
        "Rate limited. It will retry after the reset.",
        now,
        when,
        0,
        false,
      );
      return "rate_limit";
    }
    case "pause": {
      await resolveAttempt(env, ctx.attemptId, "not_posted", now);
      await releaseSlot(env, ctx.segmentId);
      await setItem(env, ctx, "scheduled", null, null, now, null, 1, false);
      return "missed";
    }
    case "ambiguous":
    case "lost_lease": {
      const existing = await env.DB.prepare(
        "SELECT x_post_id FROM segments WHERE id = ?",
      )
        .bind(ctx.segmentId)
        .first<{ x_post_id: string | null }>();
      if (existing?.x_post_id) {
        return settle(
          env,
          ctx,
          { type: "success", postId: existing.x_post_id },
          now,
        );
      }
      await releaseSlot(env, ctx.segmentId);
      const settledAt = decision.type === "ambiguous" ? Date.now() : now;
      const detail = decision.type === "ambiguous" ? decision.detail : UNKNOWN;
      await setItem(
        env,
        ctx,
        "needs_you",
        "unknown",
        detail,
        settledAt,
        null,
        0,
        true,
      );
      return "needs_you";
    }
    default: {
      const neverDecision: never = decision;
      return neverDecision;
    }
  }
}

async function ensureMediaId(
  env: Env,
  holder: Holder,
  itemId: string,
  leaseId: string,
  media: ItemRecord["segments"][number]["media"][number],
  now: number,
): Promise<{ type: "ok"; value: string } | Decision> {
  if (media.xMediaId && (media.xMediaExpiresAt ?? 0) > now) {
    return { type: "ok", value: media.xMediaId };
  }
  const object = await env.MEDIA.get(media.r2Key);
  if (!object) {
    return { type: "rejected", detail: "The image is missing from storage." };
  }
  if (object.size > 5 * 1024 * 1024) {
    return { type: "rejected", detail: "Each image must be 5 MB or smaller." };
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (!(await renewLease(env, itemId, leaseId))) return { type: "lost_lease" };
  const uploaded = decideCall(
    await callX(env, itemId, holder, now, (token) =>
      uploadMedia(env, token, bytes, media.mime),
    ),
  );
  if (uploaded.type !== "ok") return uploaded;
  await env.DB.prepare(
    `UPDATE media SET x_media_id = ?, x_media_expires_at = ?
     WHERE id = ? AND x_media_id IS NULL`,
  )
    .bind(uploaded.value.id, now + MEDIA_TTL_MS, media.id)
    .run();
  if (!(await renewLease(env, itemId, leaseId))) return { type: "lost_lease" };
  const alt = decideCall(
    await callX(env, itemId, holder, now, (token) =>
      setAltText(env, token, uploaded.value.id, media.altText),
    ),
  );
  if (alt.type !== "ok") return alt;
  return { type: "ok", value: uploaded.value.id };
}

async function postArticle(
  env: Env,
  item: ItemRecord,
  leaseId: string,
  holder: Holder,
  now: number,
): Promise<Decision> {
  const segment = item.segments[0];
  if (!segment) {
    return { type: "rejected", detail: "The article has no body." };
  }
  let articleId = item.xArticleId;
  if (!articleId) {
    if (!(await renewLease(env, item.id, leaseId)))
      return { type: "lost_lease" };
    const draft = decideCall(
      await callX(env, item.id, holder, now, (token) =>
        createArticleDraft(env, token, item.title ?? "Untitled", segment.text),
      ),
    );
    if (draft.type !== "ok") return draft;
    articleId = draft.value.id;
    await env.DB.prepare(
      "UPDATE items SET x_article_id = ? WHERE id = ? AND x_article_id IS NULL",
    )
      .bind(articleId, item.id)
      .run();
  }
  if (!(await renewLease(env, item.id, leaseId))) return { type: "lost_lease" };
  if (!(await postingGate(env)).allowed) return { type: "pause" };
  const published = decideCall(
    await callX(env, item.id, holder, now, (token) =>
      publishArticle(env, token, articleId as string),
    ),
  );
  if (published.type !== "ok") return published;
  return { type: "success", postId: published.value.postId };
}

async function postOneSegment(
  env: Env,
  item: ItemRecord,
  segment: ItemRecord["segments"][number],
  leaseId: string,
  holder: Holder,
  now: number,
): Promise<Decision> {
  let replyTo: string | null = null;
  for (const earlier of item.segments) {
    if (earlier.position >= segment.position) break;
    if (earlier.xPostId) replyTo = earlier.xPostId;
  }
  const mediaIds: string[] = [];
  for (const media of segment.media) {
    const mediaId = await ensureMediaId(
      env,
      holder,
      item.id,
      leaseId,
      media,
      now,
    );
    if (mediaId.type !== "ok") return mediaId;
    mediaIds.push(mediaId.value);
  }
  if (!(await renewLease(env, item.id, leaseId))) return { type: "lost_lease" };
  if (!(await postingGate(env)).allowed) return { type: "pause" };
  const tweet = decideCall(
    await callX(env, item.id, holder, now, (token) =>
      createPost(env, token, segment.text, mediaIds, replyTo),
    ),
  );
  if (tweet.type !== "ok") return tweet;
  return { type: "success", postId: tweet.value.id };
}

async function parkUnclaimed(
  env: Env,
  item: ItemRecord,
  now: number,
): Promise<string> {
  const gate = await postingGate(env);
  if (!gate.allowed) {
    await markMissedDue(env, now);
    return "missed";
  }
  const account = await publicAccount(env);
  const bound = await env.DB.prepare(
    "SELECT approved_x_user_id FROM items WHERE id = ?",
  )
    .bind(item.id)
    .first<{ approved_x_user_id: string | null }>();
  const open = await env.DB.prepare(
    "SELECT id FROM post_attempts WHERE item_id = ? AND outcome IS NULL LIMIT 1",
  )
    .bind(item.id)
    .first();
  const userOk =
    Boolean(bound?.approved_x_user_id) &&
    bound?.approved_x_user_id === account.userId &&
    account.connected &&
    !account.needsReconnect;
  let reason: "unknown" | "rejected" = "rejected";
  let error = "This post cannot be sent.";
  if (open) {
    reason = "unknown";
    error = UNKNOWN;
  } else if (!userOk) {
    error = PARKED;
  } else if (item.approvedHash !== item.contentHash) {
    error = "Approval does not match the current text.";
  }
  const result = await env.DB.prepare(
    `UPDATE items SET status = 'needs_you', needs_reason = ?, last_error = ?,
       lease_id = NULL, resend_segment_id = NULL, updated_at = ?
     WHERE id = ? AND status = 'scheduled' AND missed = 0`,
  )
    .bind(reason, error, now, item.id)
    .run();
  if (rowChanges(result) === 1) {
    await audit(
      env,
      item.id,
      "scheduled",
      "needs_you",
      reason,
      item.contentHash,
      now,
    );
  }
  return "needs_you";
}

async function postItem(
  env: Env,
  id: string,
  holder: Holder,
  now: number,
): Promise<string> {
  const item = await getItem(env, id);
  if (!item) return "skipped";
  if (item.status !== "scheduled" || item.missed) return "skipped";
  if (item.approvedHash !== item.contentHash)
    return parkUnclaimed(env, item, now);
  const gate = await postingGate(env);
  if (!gate.allowed) {
    await markMissedDue(env, now);
    return "missed";
  }
  const limits = postLimits(env);
  const account = await publicAccount(env);
  const prefs = await readPreferences(env);
  const plan = effectivePlan(prefs.planOverride, account.subscriptionType);
  const textCap =
    item.kind === "article" ? limits.premium : limitForPlan(limits, plan);
  const over = item.segments.some(
    (segment) => !segment.xPostId && textOverCap(segment.text, textCap),
  );
  if (over) {
    const result = await env.DB.prepare(
      `UPDATE items SET status = 'needs_you', needs_reason = 'rejected', last_error = ?, updated_at = ?
       WHERE id = ? AND status = 'scheduled' AND lease_id IS NULL`,
    )
      .bind(OVER_LIMIT, now, id)
      .run();
    if (rowChanges(result) === 1) {
      await audit(
        env,
        id,
        "scheduled",
        "needs_you",
        "rejected",
        item.contentHash,
        now,
      );
    }
    return "needs_you";
  }
  const segment = item.segments.find((entry) => !entry.xPostId);
  if (!segment) {
    await env.DB.prepare(
      `UPDATE items SET status = 'posted', posted_at = COALESCE(posted_at, ?), updated_at = ?
       WHERE id = ? AND status = 'scheduled'`,
    )
      .bind(now, now, id)
      .run();
    return "posted";
  }
  const day = dayKey(now, prefs.timeZone);
  const dailyCap = Number(env.MAX_DAILY_POSTS);
  const capped = Number.isFinite(dailyCap);
  if (capped) {
    const reserved = await reserveSlot(env, segment.id, day, dailyCap, now);
    if (!reserved) {
      if ((await postsInWindow(env, now)) >= dailyCap) return "daily_cap";
      return "skipped";
    }
  }
  const leaseId = ulid(now);
  const claimed = await claimSegment(env, id, segment.id, leaseId, now);
  if (!claimed) {
    if (capped) await releaseSlot(env, segment.id);
    return parkUnclaimed(env, item, now);
  }
  await audit(env, id, "scheduled", "posting", "claim", item.contentHash, now);
  const ctx: SettleCtx = {
    itemId: id,
    contentHash: item.contentHash,
    segmentId: segment.id,
    attemptId: leaseId,
    leaseId,
    day,
    scheduledAt: item.scheduledAt,
  };
  const itemHolder: Holder = { token: holder.token, refreshed: false };
  let decision: Decision;
  try {
    decision =
      item.kind === "article"
        ? await postArticle(env, item, leaseId, itemHolder, now)
        : await postOneSegment(env, item, segment, leaseId, itemHolder, now);
  } catch (error) {
    log("error", "dispatch_item_failed", {
      item_id: id,
      message: error instanceof Error ? error.name : "error",
    });
    decision = {
      type: "ambiguous",
      detail: "The request to X did not finish.",
    };
  }
  holder.token = itemHolder.token;
  return settle(env, ctx, decision, now);
}

async function sweepStale(env: Env, now: number): Promise<void> {
  const stale = await env.DB.prepare(
    `SELECT items.id, items.content_hash, items.lease_id, items.scheduled_at,
            items.pending_resolution,
            post_attempts.id AS attempt_id, post_attempts.segment_id
     FROM items
     LEFT JOIN post_attempts
       ON post_attempts.id = items.lease_id AND post_attempts.outcome IS NULL
     WHERE items.status = 'posting'
       AND items.lease_until IS NOT NULL
       AND items.lease_until < ?`,
  )
    .bind(now)
    .all<{
      id: string;
      content_hash: string;
      lease_id: string | null;
      scheduled_at: number | null;
      pending_resolution: string | null;
      attempt_id: string | null;
      segment_id: string | null;
    }>();
  const zone = (await readPreferences(env)).timeZone;
  for (const row of stale.results ?? []) {
    if (!row.lease_id || !row.attempt_id || !row.segment_id) {
      if (row.pending_resolution === "account_switch") {
        await settleAccountSwitch(env, row.id, now, "inflight");
        continue;
      }
      await settleOrphanPosting(env, row.id, row.content_hash, now);
      continue;
    }
    await settle(
      env,
      {
        itemId: row.id,
        contentHash: row.content_hash,
        segmentId: row.segment_id,
        attemptId: row.attempt_id,
        leaseId: row.lease_id,
        day: dayKey(now, zone),
        scheduledAt: row.scheduled_at,
      },
      { type: "lost_lease" },
      now,
    );
  }
}

async function claimDispatch(env: Env, now: number): Promise<string | null> {
  const id = ulid(now);
  const result = await env.DB.prepare(
    `UPDATE app_settings SET dispatch_lease_id = ?, dispatch_lease_until = ?
     WHERE id = 1 AND (dispatch_lease_until IS NULL OR dispatch_lease_until < ?)`,
  )
    .bind(id, now + DISPATCH_LEASE_MS, now)
    .run();
  return rowChanges(result) === 1 ? id : null;
}

async function releaseDispatch(env: Env, id: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE app_settings SET dispatch_lease_id = NULL, dispatch_lease_until = NULL
     WHERE id = 1 AND dispatch_lease_id = ?`,
  )
    .bind(id)
    .run();
}

export async function dispatch(
  env: Env,
  now: number,
): Promise<{ posted: number; skipped: string | null }> {
  await sweepStale(env, now);
  const lock = await claimDispatch(env, now);
  if (!lock) return { posted: 0, skipped: "dispatch_running" };
  try {
    await releaseExpiredHolds(env, now);
    const gate = await postingGate(env);
    if (!gate.allowed) {
      await notePostingBlocked(env, now);
      await markMissedDue(env, now);
      return { posted: 0, skipped: "posting_disabled" };
    }
    if ((await postingBlockedSince(env)) !== null) {
      await markMissedDue(env, now);
      await clearPostingBlocked(env);
    }
    const token = await accessTokenForPosting(env, now);
    if (!token) {
      await markMissedDue(env, now);
      await noteDisconnected(env, now);
      return { posted: 0, skipped: "needs_reconnect" };
    }
    const cap = Number(env.MAX_DAILY_POSTS);
    if (Number.isFinite(cap) && (await postsInWindow(env, now)) >= cap) {
      return { posted: 0, skipped: "daily_cap" };
    }
    const due = await env.DB.prepare(
      `SELECT id FROM items
       WHERE status = 'scheduled' AND missed = 0 AND scheduled_at <= ? AND approved_hash = content_hash
       ORDER BY scheduled_at ASC LIMIT 5`,
    )
      .bind(now)
      .all<{ id: string }>();
    const holder: Holder = { token, refreshed: false };
    let posted = 0;
    for (const row of due.results ?? []) {
      if (Number.isFinite(cap) && (await postsInWindow(env, now)) >= cap) break;
      const outcome = await postItem(env, row.id, holder, now);
      if (outcome === "daily_cap") break;
      if (outcome === "posted" || outcome === "segment") posted += 1;
    }
    return { posted, skipped: null };
  } finally {
    await releaseDispatch(env, lock);
  }
}

const SWITCHED =
  "Connected a different X account. This thread stays tied to the previous one.";

async function settleOrphanPosting(
  env: Env,
  itemId: string,
  contentHash: string,
  now: number,
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE items SET status = 'needs_you', needs_reason = 'unknown', lease_id = NULL,
       last_error = ?, pending_resolution = NULL, updated_at = ?
     WHERE id = ? AND status = 'posting' AND lease_until < ?`,
  )
    .bind(UNKNOWN, now, itemId, now)
    .run();
  if (rowChanges(result) === 1) {
    await audit(
      env,
      itemId,
      "posting",
      "needs_you",
      "unknown",
      contentHash,
      now,
    );
  }
}

// Idle rows are not in the middle of a send. A stored post id stays on X.
// Nothing posted goes back to draft. An in-flight row with no stored id is
// unknown: Needs you, and it is not approved for another automatic send.
async function settleAccountSwitch(
  env: Env,
  itemId: string,
  now: number,
  mode: "idle" | "inflight",
): Promise<void> {
  const counts = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN x_post_id IS NOT NULL THEN 1 ELSE 0 END) AS posted,
       SUM(CASE WHEN x_post_id IS NULL THEN 1 ELSE 0 END) AS open
     FROM segments WHERE item_id = ?`,
  )
    .bind(itemId)
    .first<{ posted: number | null; open: number | null }>();
  await env.DB.prepare(
    "DELETE FROM daily_slots WHERE segment_id IN (SELECT id FROM segments WHERE item_id = ?)",
  )
    .bind(itemId)
    .run();
  const row = await env.DB.prepare(
    "SELECT status, content_hash FROM items WHERE id = ?",
  )
    .bind(itemId)
    .first<{ status: string; content_hash: string }>();
  if (!row) return;
  const posted = counts?.posted ?? 0;
  const open = counts?.open ?? 0;
  const where = `WHERE id = ? AND pending_resolution = 'account_switch'
         AND status IN ('posting', 'scheduled', 'approved', 'needs_you', 'draft')`;
  if (posted > 0 && open === 0) {
    const result = await env.DB.prepare(
      `UPDATE items SET status = 'posted', needs_reason = NULL, last_error = NULL,
         posted_at = COALESCE(posted_at, ?),
         lease_id = NULL, lease_until = NULL, resend_segment_id = NULL,
         pending_resolution = NULL, missed = 0, updated_at = ?
       ${where}`,
    )
      .bind(now, now, itemId)
      .run();
    if (rowChanges(result) === 1) {
      await audit(
        env,
        itemId,
        row.status,
        "posted",
        "account_switch",
        row.content_hash,
        now,
      );
    }
    return;
  }
  if (posted > 0 || mode === "inflight") {
    const unknown = posted === 0;
    const result = await env.DB.prepare(
      `UPDATE items SET status = 'needs_you',
         needs_reason = ?,
         last_error = ?,
         approved_hash = CASE WHEN ? = 1 THEN approved_hash ELSE NULL END,
         approved_at = CASE WHEN ? = 1 THEN approved_at ELSE NULL END,
         approved_by = CASE WHEN ? = 1 THEN approved_by ELSE NULL END,
         approved_x_user_id = CASE WHEN ? = 1 THEN approved_x_user_id ELSE NULL END,
         scheduled_at = CASE WHEN ? = 1 THEN scheduled_at ELSE NULL END,
         missed = 0,
         lease_id = NULL,
         lease_until = CASE WHEN ? = 1 THEN lease_until ELSE NULL END,
         resend_segment_id = NULL,
         pending_resolution = NULL,
         updated_at = ?
       ${where}`,
    )
      .bind(
        unknown ? "unknown" : "rejected",
        unknown ? UNKNOWN : SWITCHED,
        unknown ? 1 : 0,
        unknown ? 1 : 0,
        unknown ? 1 : 0,
        unknown ? 1 : 0,
        unknown ? 1 : 0,
        unknown ? 1 : 0,
        now,
        itemId,
      )
      .run();
    if (rowChanges(result) === 1) {
      await audit(
        env,
        itemId,
        row.status,
        "needs_you",
        unknown ? "unknown" : "account_switch",
        row.content_hash,
        now,
      );
    }
    return;
  }
  const result = await env.DB.prepare(
    `UPDATE items SET status = 'draft', review_stage = 'draft',
       needs_reason = NULL, last_error = NULL,
       approved_hash = NULL, approved_at = NULL, approved_by = NULL,
       approved_x_user_id = NULL, scheduled_at = NULL, missed = 0,
       lease_id = NULL, lease_until = NULL, resend_segment_id = NULL,
       pending_resolution = NULL, updated_at = ?
     ${where}`,
  )
    .bind(now, itemId)
    .run();
  if (rowChanges(result) === 1) {
    await audit(
      env,
      itemId,
      row.status,
      "draft",
      "account_switch",
      row.content_hash,
      now,
    );
  }
}

async function settleIdleSwitches(env: Env, now: number): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id FROM items
     WHERE pending_resolution = 'account_switch'
       AND status != 'posting'
       AND NOT EXISTS (
         SELECT 1 FROM post_attempts
         WHERE post_attempts.item_id = items.id AND outcome IS NULL
       )`,
  ).all<{ id: string }>();
  for (const row of rows.results ?? []) {
    await settleAccountSwitch(env, row.id, now, "idle");
  }
}

registerIdleSettle(settleIdleSwitches);
