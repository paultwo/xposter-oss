import type { Hono } from "hono";
import { allowedEmails } from "../auth/access";
import { approve, requireItem, schedule } from "../http/actions";
import { draftFromJson } from "../http/parse";
import { presentItem } from "../http/present";
import { actorOf, idOf } from "../http/shell";
import type { AppEnv } from "../http/types";
import { AppError } from "../items/model";
import {
  archiveItem,
  createDraft,
  deleteItem,
  draftsFromIntake,
  importBuffer,
  markPostedItem,
  markSegmentFromUrl,
  patchIntakeDraft,
  postNowItem,
  rescheduleMissed,
  retryItem,
  unscheduleItem,
  updateDraft,
} from "../items/service";
import { getItem, listItems } from "../items/store";
import { limitForPlan, longPostsAllowed, postLimits } from "../lib/plan";
import { effectivePlan, readPreferences } from "../lib/settings";
import { foldAt, weightedLength } from "../lib/text";
import { pauseAllPosting } from "../posting/control";
import { dispatch } from "../posting/dispatch";
import { publicAccount } from "../x/account";

export function registerApiRoutes(app: Hono<AppEnv>): void {
  app.get("/api/account", async (c) => {
    const account = await publicAccount(c.env);
    return c.json({
      connected: account.connected,
      username: account.username,
      scopes: account.scopes,
      expires_at: account.expiresAt,
      needs_reconnect: account.needsReconnect,
      posting_enabled: c.env.POSTING_ENABLED === "true",
      approvers: allowedEmails(c.env),
    });
  });

  app.get("/api/items", async (c) => {
    const items = await listItems(c.env, [
      "draft",
      "approved",
      "scheduled",
      "posting",
      "posted",
      "needs_you",
    ]);
    return c.json({ items: items.map(presentItem) });
  });

  app.get("/api/items/:id", async (c) =>
    c.json({ item: presentItem(await requireItem(c)) }),
  );

  app.post("/api/items", async (c) => {
    const input = draftFromJson(await c.req.json());
    const saved = await createDraft(c.env, {
      ...input,
      source: "you",
      sourceRef: null,
      actor: actorOf(c),
      now: Date.now(),
    });
    return c.json({ item: presentItem(saved.item) }, 201);
  });

  app.patch("/api/items/:id", async (c) => {
    const input = draftFromJson(await c.req.json());
    const item = await updateDraft(
      c.env,
      idOf(c),
      input,
      actorOf(c),
      Date.now(),
    );
    return c.json({ item: presentItem(item) });
  });

  app.post("/api/items/:id/approve", (c) => approve(c, false));
  app.post("/api/items/:id/schedule", (c) => schedule(c, false));
  app.post("/api/items/:id/unschedule", async (c) =>
    c.json({
      item: presentItem(
        await unscheduleItem(c.env, idOf(c), actorOf(c), Date.now()),
      ),
    }),
  );
  app.post("/api/items/:id/archive", async (c) =>
    c.json({
      item: presentItem(
        await archiveItem(c.env, idOf(c), actorOf(c), Date.now()),
      ),
    }),
  );
  app.delete("/api/items/:id", async (c) => {
    const raw = await c.req.text();
    let confirm = false;
    if (raw) {
      try {
        confirm = (JSON.parse(raw) as { confirm?: unknown }).confirm === true;
      } catch {
        confirm = false;
      }
    }
    if (!confirm) {
      throw new AppError(
        409,
        'Confirm before deleting. Send {"confirm": true}.',
      );
    }
    const deleted = await deleteItem(c.env, idOf(c), actorOf(c), Date.now());
    return c.json({ deleted: true, id: deleted.id, was: deleted.status });
  });
  app.post("/api/items/:id/retry", async (c) => {
    const raw = await c.req.text();
    let position: number | null = null;
    let confirm = false;
    if (raw) {
      const body = JSON.parse(raw) as { position?: unknown; confirm?: unknown };
      if (typeof body.position === "number") position = body.position;
      confirm = body.confirm === true;
    }
    return c.json({
      item: presentItem(
        await retryItem(
          c.env,
          idOf(c),
          actorOf(c),
          Date.now(),
          position,
          confirm,
        ),
      ),
    });
  });
  app.post("/api/items/:id/mark-link", async (c) => {
    const body = await c.req.json<{ status_url?: string }>();
    return c.json({
      item: presentItem(
        await markSegmentFromUrl(
          c.env,
          idOf(c),
          actorOf(c),
          Date.now(),
          body.status_url ?? "",
        ),
      ),
    });
  });
  app.post("/api/items/:id/reschedule", async (c) => {
    const body = await c.req.json<{ scheduled_at?: number }>();
    return c.json({
      item: presentItem(
        await rescheduleMissed(
          c.env,
          idOf(c),
          actorOf(c),
          Date.now(),
          Number(body.scheduled_at),
        ),
      ),
    });
  });
  app.post("/api/settings/pause", async (c) => {
    await pauseAllPosting(c.env, actorOf(c), Date.now());
    return c.json({ posting_paused: true });
  });
  app.post("/api/items/:id/post-now", async (c) =>
    c.json({
      item: presentItem(
        await postNowItem(c.env, idOf(c), actorOf(c), Date.now()),
      ),
    }),
  );
  app.post("/api/items/:id/mark-posted", async (c) =>
    c.json({
      item: presentItem(
        await markPostedItem(c.env, idOf(c), actorOf(c), Date.now()),
      ),
    }),
  );
  app.post("/api/count", async (c) => {
    const body = await c.req.json<{ text?: string; kind?: string }>();
    const text = typeof body.text === "string" ? body.text : "";
    const limits = postLimits(c.env);
    const account = await publicAccount(c.env);
    const prefs = await readPreferences(c.env);
    const plan = effectivePlan(prefs.planOverride, account.subscriptionType);
    const article = body.kind === "article";
    const limit = article ? limits.premium : limitForPlan(limits, plan);
    const weighted = weightedLength(text);
    const folded = foldAt(text, limits.showMoreAt);
    return c.json({
      weighted,
      limit,
      over: weighted > limit,
      standard: limits.standard,
      pastStandard: !article && weighted > limits.standard,
      longPosts: longPostsAllowed(plan),
      showMoreAt: limits.showMoreAt,
      head: folded.head,
      rest: folded.rest,
    });
  });
  app.post("/api/admin/import/buffer", async (c) => {
    const result = await importBuffer(
      c.env,
      await c.req.json(),
      actorOf(c),
      Date.now(),
    );
    return c.json(result);
  });

  app.post("/api/intake/drafts", async (c) => {
    const identity = c.get("identity");
    if (identity.kind !== "service") return c.text("Forbidden", 403);
    const result = await draftsFromIntake(
      c.env,
      identity.tokenId,
      await c.req.json(),
      actorOf(c),
      Date.now(),
    );
    return c.json(
      { item: presentItem(result.item) },
      result.created ? 201 : 200,
    );
  });
  app.get("/api/intake/drafts/:id", async (c) => {
    const identity = c.get("identity");
    if (identity.kind !== "service") return c.text("Forbidden", 403);
    const item = await getItem(c.env, idOf(c));
    if (!item || item.source !== identity.tokenId)
      return c.text("Not found", 404);
    return c.json({ item: presentItem(item) });
  });
  app.patch("/api/intake/drafts/:id", async (c) => {
    const identity = c.get("identity");
    if (identity.kind !== "service") return c.text("Forbidden", 403);
    const item = await patchIntakeDraft(
      c.env,
      identity.tokenId,
      idOf(c),
      await c.req.json(),
      actorOf(c),
      Date.now(),
    );
    return c.json({ item: presentItem(item) });
  });

  app.post("/__dev/dispatch", async (c) => {
    if (c.env.ENVIRONMENT !== "development") return c.notFound();
    const host = new URL(c.req.url).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") return c.notFound();
    let now = Date.now();
    const raw = await c.req.text();
    if (raw.trim()) {
      let body: { now?: unknown };
      try {
        body = JSON.parse(raw) as { now?: unknown };
      } catch {
        return c.text("Bad request", 400);
      }
      if (typeof body.now === "number" && Number.isFinite(body.now)) {
        now = body.now;
      }
    }
    return c.json(await dispatch(c.env, now));
  });
}
