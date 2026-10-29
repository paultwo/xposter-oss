import {
  limitForPlan,
  longPostsAllowed,
  type PostLimits,
  postLimits,
  type XPlan,
} from "../lib/plan";
import { effectivePlan, readPreferences } from "../lib/settings";
import { nextStatus, type Status } from "../lib/state";
import { parseStatusUrl } from "../lib/status-url";
import { overLimitCopy, weightedLength } from "../lib/text";
import { dayKey, zoneLabel } from "../lib/time";
import { recordPostedDay, releaseSlot } from "../posting/cap";
import { accessTokenForPosting, publicAccount } from "../x/account";
import { fetchPostAuthor, xFetchTimeoutMs } from "../x/client";
import { auditStatement } from "./content";
import { AppError, type ItemRecord } from "./model";
import { getItem, rowChanges } from "./store";

export function approvalBlocker(
  item: Pick<ItemRecord, "kind" | "title" | "segments">,
  plan: XPlan,
  limits: PostLimits,
): string | null {
  const cap =
    item.kind === "article" ? limits.premium : limitForPlan(limits, plan);
  if (item.kind === "article" && !item.title)
    return "An Article needs a title.";
  for (const segment of item.segments) {
    const length = weightedLength(segment.text);
    if (length <= cap) continue;
    if (!longPostsAllowed(plan) && item.kind !== "article") {
      return overLimitCopy(length, limits.standard);
    }
    return `A segment is over ${cap.toLocaleString("en-US")} characters.`;
  }
  return null;
}

async function assertApprovable(env: Env, item: ItemRecord): Promise<void> {
  const account = await publicAccount(env);
  const prefs = await readPreferences(env);
  const blocker = approvalBlocker(
    item,
    effectivePlan(prefs.planOverride, account.subscriptionType),
    postLimits(env),
  );
  if (blocker) throw new AppError(422, blocker);
}

async function transition(
  env: Env,
  item: ItemRecord,
  actor: string,
  now: number,
  action: Parameters<typeof nextStatus>[1],
  apply: (status: Status) => D1PreparedStatement,
): Promise<ItemRecord> {
  const status = nextStatus(item.status, action);
  if (!status)
    throw new AppError(409, "That action is not available for this item.");
  const result = await apply(status).run();
  if (rowChanges(result) !== 1)
    throw new AppError(409, "That action is not available for this item.");
  await auditStatement(
    env,
    item.id,
    actor,
    action.type,
    item.status,
    status,
    item.contentHash,
    now,
  ).run();
  const saved = await getItem(env, item.id);
  if (!saved) throw new AppError(500, "The item could not be updated.");
  return saved;
}

export async function approveItem(
  env: Env,
  id: string,
  actor: string,
  now: number,
  expectedHash: string,
): Promise<ItemRecord> {
  const item = await getItem(env, id);
  if (!item) throw new AppError(404, "That draft is not here.");
  if (expectedHash !== item.contentHash)
    throw new AppError(409, "This draft changed. Review it again.");
  await assertApprovable(env, item);
  const account = await publicAccount(env);
  if (!account.connected || !account.userId) {
    throw new AppError(409, "Connect X before approving.");
  }
  const userId = account.userId;
  return transition(env, item, actor, now, { type: "approve" }, (status) =>
    env.DB.prepare(
      `UPDATE items SET status = ?, review_stage = 'draft', approved_hash = content_hash,
         approved_at = ?, approved_by = ?, approved_x_user_id = ?, updated_at = ?
       WHERE id = ? AND status = 'draft' AND content_hash = ? AND ? IS NOT NULL`,
    ).bind(status, now, actor, userId, now, id, expectedHash, userId),
  );
}

export async function scheduleItem(
  env: Env,
  id: string,
  actor: string,
  now: number,
  scheduledAt: number,
): Promise<ItemRecord> {
  const item = await getItem(env, id);
  if (!item) throw new AppError(404, "That draft is not here.");
  if (item.approvedHash !== item.contentHash)
    throw new AppError(409, "Approval does not match the current text.");
  if (!Number.isFinite(scheduledAt) || scheduledAt <= now) {
    const zone = zoneLabel(now, (await readPreferences(env)).timeZone);
    const when = Number.isFinite(scheduledAt)
      ? "future date and time"
      : "date and time";
    throw new AppError(422, `Pick a ${when} in ${zone}.`);
  }
  return transition(env, item, actor, now, { type: "schedule" }, (status) =>
    env.DB.prepare(
      `UPDATE items SET status = ?, scheduled_at = ?, missed = 0, updated_at = ?
       WHERE id = ? AND status = 'approved' AND approved_hash = content_hash`,
    ).bind(status, scheduledAt, now, id),
  );
}

export async function postNowItem(
  env: Env,
  id: string,
  actor: string,
  now: number,
): Promise<ItemRecord> {
  return scheduleItem(env, id, actor, now, now + 60_000);
}

export async function unscheduleItem(
  env: Env,
  id: string,
  actor: string,
  now: number,
): Promise<ItemRecord> {
  const item = await getItem(env, id);
  if (!item) throw new AppError(404, "That draft is not here.");
  return transition(env, item, actor, now, { type: "unschedule" }, (status) =>
    env.DB.prepare(
      "UPDATE items SET status = ?, scheduled_at = NULL, missed = 0, lease_id = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'scheduled'",
    ).bind(status, now, id),
  );
}

export async function archiveItem(
  env: Env,
  id: string,
  actor: string,
  now: number,
): Promise<ItemRecord> {
  const item = await getItem(env, id);
  if (!item) throw new AppError(404, "That draft is not here.");
  return transition(env, item, actor, now, { type: "archive" }, (status) =>
    env.DB.prepare(
      "UPDATE items SET status = ?, scheduled_at = NULL, updated_at = ? WHERE id = ? AND status = ?",
    ).bind(status, now, id, item.status),
  );
}

export async function retryItem(
  env: Env,
  id: string,
  actor: string,
  now: number,
  onlyPosition: number | null = null,
  confirm = false,
): Promise<ItemRecord> {
  if (!confirm || onlyPosition === null) {
    throw new AppError(409, "Confirm before sending this post again.");
  }
  const item = await getItem(env, id);
  if (!item) throw new AppError(404, "That draft is not here.");
  if (item.approvedHash !== item.contentHash) {
    throw new AppError(409, "Approval does not match the current text.");
  }
  if (nextStatus(item.status, { type: "resume" }) !== "scheduled") {
    throw new AppError(409, "That action is not available for this item.");
  }
  const segment = item.segments.find(
    (entry) => entry.position === onlyPosition,
  );
  if (!segment || segment.xPostId) {
    throw new AppError(409, "That post is not waiting to be sent.");
  }
  const attempt = await env.DB.prepare(
    "SELECT id, outcome FROM post_attempts WHERE segment_id = ? ORDER BY started_at DESC LIMIT 1",
  )
    .bind(segment.id)
    .first<{ id: string; outcome: string | null }>();
  if (item.needsReason === "unknown") {
    if (!attempt || attempt.outcome !== null) {
      throw new AppError(409, "That post is not waiting to be sent.");
    }
    const waitUntil = (item.leaseUntil ?? 0) + xFetchTimeoutMs(env);
    if (item.leaseUntil !== null && now < waitUntil) {
      throw new AppError(
        409,
        "Wait until the last attempt has finished, then check X.",
      );
    }
    if (item.kind === "article") {
      throw new AppError(
        409,
        "This Article might already be on X. Paste its link. It will not be published again.",
      );
    }
    const removed = await env.DB.prepare(
      `DELETE FROM post_attempts
       WHERE id = ? AND outcome IS NULL AND segment_id = ?
         AND EXISTS (
           SELECT 1 FROM items
           WHERE items.id = ? AND items.status = 'needs_you' AND items.needs_reason = 'unknown'
             AND items.approved_hash = items.content_hash
         )`,
    )
      .bind(attempt.id, segment.id, id)
      .run();
    if (rowChanges(removed) !== 1) {
      throw new AppError(409, "That post is not waiting to be sent.");
    }
    await releaseSlot(env, segment.id);
  } else if (item.needsReason !== "rejected" || attempt?.outcome === null) {
    throw new AppError(409, "That post is not waiting to be sent.");
  }
  const result = await env.DB.prepare(
    `UPDATE items SET status = 'scheduled', scheduled_at = ?, resend_segment_id = ?, missed = 0,
       needs_reason = NULL, last_error = NULL, lease_id = NULL, lease_until = NULL, updated_at = ?
     WHERE id = ? AND status = 'needs_you' AND approved_hash = content_hash`,
  )
    .bind(now, segment.id, now, id)
    .run();
  if (rowChanges(result) !== 1) {
    throw new AppError(409, "That action is not available for this item.");
  }
  await auditStatement(
    env,
    id,
    actor,
    "resume",
    "needs_you",
    "scheduled",
    item.contentHash,
    now,
  ).run();
  const saved = await getItem(env, id);
  if (!saved) throw new AppError(500, "The item could not be updated.");
  return saved;
}

export async function rescheduleMissed(
  env: Env,
  id: string,
  actor: string,
  now: number,
  scheduledAt: number,
): Promise<ItemRecord> {
  const item = await getItem(env, id);
  if (!item) throw new AppError(404, "That draft is not here.");
  if (item.status !== "scheduled" || !item.missed) {
    throw new AppError(409, "That item is not missed.");
  }
  if (!Number.isFinite(scheduledAt) || scheduledAt <= now) {
    const zone = zoneLabel(now, (await readPreferences(env)).timeZone);
    throw new AppError(422, `Pick a future date and time in ${zone}.`);
  }
  const result = await env.DB.prepare(
    `UPDATE items SET scheduled_at = ?, missed = 0, updated_at = ?
     WHERE id = ? AND status = 'scheduled' AND missed = 1`,
  )
    .bind(scheduledAt, now, id)
    .run();
  if (rowChanges(result) !== 1)
    throw new AppError(409, "That item is not missed.");
  await auditStatement(
    env,
    id,
    actor,
    "reschedule",
    "scheduled",
    "scheduled",
    item.contentHash,
    now,
  ).run();
  const saved = await getItem(env, id);
  if (!saved) throw new AppError(500, "The item could not be updated.");
  return saved;
}

export async function restoreItem(
  env: Env,
  id: string,
  actor: string,
  now: number,
): Promise<ItemRecord> {
  const item = await getItem(env, id);
  if (!item) throw new AppError(404, "That draft is not here.");
  return transition(env, item, actor, now, { type: "restore" }, (status) =>
    env.DB.prepare(
      `UPDATE items SET status = ?, review_stage = 'draft', missed = 0, scheduled_at = NULL,
         approved_hash = NULL, approved_at = NULL, approved_by = NULL, updated_at = ?
       WHERE id = ? AND status = 'archived'`,
    ).bind(status, now, id),
  );
}

export async function markSegmentFromUrl(
  env: Env,
  id: string,
  actor: string,
  now: number,
  url: string,
): Promise<ItemRecord> {
  const item = await getItem(env, id);
  if (!item) throw new AppError(404, "That draft is not here.");
  if (item.status !== "needs_you" || item.needsReason !== "unknown") {
    throw new AppError(409, "That action is not available for this item.");
  }
  const open = await env.DB.prepare(
    `SELECT a.id AS attempt_id, s.id AS segment_id, s.position AS position
     FROM post_attempts a
     JOIN segments s ON s.id = a.segment_id
     WHERE a.item_id = ? AND a.outcome IS NULL AND s.x_post_id IS NULL
     ORDER BY s.position
     LIMIT 1`,
  )
    .bind(id)
    .first<{ attempt_id: string; segment_id: string; position: number }>();
  if (!open) throw new AppError(409, "That post is not waiting for a link.");
  const segment = item.segments.find((entry) => entry.id === open.segment_id);
  if (!segment) throw new AppError(409, "That post is not waiting for a link.");
  const account = await publicAccount(env);
  if (!account.username) {
    throw new AppError(422, "Connect X before pasting a post link.");
  }
  const postId = parseStatusUrl(url, account.username);
  if (!postId) {
    throw new AppError(
      422,
      `Paste a link like https://x.com/${account.username}/status/123.`,
    );
  }
  if (!account.connected || account.needsReconnect || !account.userId) {
    throw new AppError(422, "Connect X before pasting a post link.");
  }
  const token = await accessTokenForPosting(env, now);
  if (!token) {
    throw new AppError(422, "Connect X before pasting a post link.");
  }
  const author = await fetchPostAuthor(env, token, postId);
  if (author.type !== "ok" || author.value.authorId !== account.userId) {
    throw new AppError(422, "That post is not from the connected X account.");
  }
  const remaining = item.segments.filter(
    (entry) => entry.id !== segment.id && !entry.xPostId,
  );
  const nextStatusValue = remaining.length === 0 ? "posted" : "scheduled";
  const zone = (await readPreferences(env)).timeZone;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE segments SET x_post_id = ?, posted_at = ? WHERE id = ? AND x_post_id IS NULL",
    ).bind(postId, now, segment.id),
    env.DB.prepare(
      "UPDATE post_attempts SET outcome = 'posted', resolved_at = ? WHERE id = ? AND outcome IS NULL",
    ).bind(now, open.attempt_id),
    env.DB.prepare(
      `UPDATE items SET status = ?, needs_reason = NULL, last_error = NULL,
         posted_at = CASE WHEN ? = 'posted' THEN ? ELSE posted_at END,
         scheduled_at = CASE WHEN ? = 'scheduled' THEN ? ELSE scheduled_at END,
         resend_segment_id = NULL, lease_id = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ? AND status = 'needs_you'`,
    ).bind(
      nextStatusValue,
      nextStatusValue,
      now,
      nextStatusValue,
      now,
      now,
      id,
    ),
    auditStatement(
      env,
      id,
      actor,
      remaining.length === 0 ? "mark_posted" : "mark_segment",
      "needs_you",
      nextStatusValue,
      item.contentHash,
      now,
    ),
  ]);
  await recordPostedDay(env, segment.id, dayKey(now, zone));
  const saved = await getItem(env, id);
  if (!saved) throw new AppError(500, "The item could not be updated.");
  return saved;
}

export async function markPostedItem(
  env: Env,
  id: string,
  actor: string,
  now: number,
): Promise<ItemRecord> {
  const item = await getItem(env, id);
  if (!item) throw new AppError(404, "That draft is not here.");
  if (nextStatus(item.status, { type: "mark_posted" }) !== "posted") {
    throw new AppError(409, "That action is not available for this item.");
  }
  if (!item.segments.some((segment) => segment.xPostId)) {
    throw new AppError(409, "Nothing from this item is on X yet.");
  }
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE post_attempts SET outcome = 'not_posted', resolved_at = ? WHERE item_id = ? AND outcome IS NULL",
    ).bind(now, id),
    env.DB.prepare(
      `UPDATE items SET status = 'posted', posted_at = COALESCE(posted_at, ?), needs_reason = NULL,
         last_error = NULL, resend_segment_id = NULL, lease_id = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ? AND status = 'needs_you'`,
    ).bind(now, now, id),
    auditStatement(
      env,
      id,
      actor,
      "mark_posted",
      item.status,
      "posted",
      item.contentHash,
      now,
    ),
  ]);
  const saved = await getItem(env, id);
  if (!saved) throw new AppError(500, "The item could not be updated.");
  return saved;
}
