import type { Hono } from "hono";
import { createNamedToken, revokeNamedToken } from "../auth/intake";
import {
  applyIntent,
  approve,
  draftFromFormLoose,
  requireItem,
  saveExisting,
  saveFormFirst,
  schedule,
  settings,
  simpleAction,
} from "../http/actions";
import { draftFromForm, scheduleFromForm } from "../http/parse";
import {
  actorOf,
  editorState,
  formOf,
  formText,
  htmlWanted,
  idOf,
  listAudit,
  loadShell,
} from "../http/shell";
import type { AppEnv } from "../http/types";
import { AppError } from "../items/model";
import {
  archiveItem,
  createDraft,
  deleteItem,
  importBuffer,
  makeArticle,
  markPostedItem,
  markSegmentFromUrl,
  postNowItem,
  rescheduleMissed,
  restoreItem,
  retryItem,
  splitItem,
  unscheduleItem,
} from "../items/service";
import { listItems } from "../items/store";
import { bucketOf, bucketRank, parseFilter } from "../lib/dashboard";
import { isXPlan } from "../lib/plan";
import { readPreferences, savePreferences } from "../lib/settings";
import { upcomingEtDays } from "../lib/time";
import { isUlid } from "../lib/ulid";
import { pauseAllPosting } from "../posting/control";
import { DashboardPage } from "../ui/dashboard";
import {
  ArchivedPage,
  EditorPage,
  HistoryPage,
  QueuePage,
  ReviewPage,
} from "../ui/pages";
import { publicAccount, readAvatar } from "../x/account";
import { xFetchTimeoutMs } from "../x/client";

export function registerHtmlRoutes(app: Hono<AppEnv>): void {
  app.get("/", async (c) => {
    const filter = parseFilter(c.req.query("status"));
    const shell = await loadShell(c, "Drafts", "/");
    const items = await listItems(c.env, [
      "draft",
      "approved",
      "scheduled",
      "posting",
      "posted",
      "needs_you",
    ]);
    items.sort(
      (a, b) =>
        bucketRank(bucketOf(a.status, a.reviewStage, a.missed)) -
          bucketRank(bucketOf(b.status, b.reviewStage, b.missed)) ||
        b.updatedAt - a.updatedAt,
    );
    return c.html(
      <DashboardPage shell={shell} filter={filter} items={items} />,
    );
  });

  app.get("/queue", async (c) => {
    const shell = await loadShell(c, "Queue", "/queue");
    const items = await listItems(c.env, [
      "draft",
      "approved",
      "scheduled",
      "posting",
    ]);
    return c.html(
      <QueuePage
        shell={shell}
        days={upcomingEtDays(
          Date.now(),
          7,
          (await readPreferences(c.env)).timeZone,
        )}
        items={items}
      />,
    );
  });

  app.get("/compose", async (c) => {
    const shell = await loadShell(c, "New draft", "/compose");
    const state = editorState(null);
    return c.html(
      <EditorPage
        shell={shell}
        item={null}
        errors={{}}
        message={null}
        {...state}
      />,
    );
  });

  app.get("/items/:id", async (c) => {
    const item = await requireItem(c);
    const shell = await loadShell(c, "Edit draft", "");
    return c.html(
      <EditorPage
        shell={shell}
        item={item}
        errors={{}}
        message={null}
        {...editorState(item)}
      />,
    );
  });

  app.get("/items/:id/review", async (c) => {
    const item = await requireItem(c);
    const shell = await loadShell(c, "Review", "/");
    return c.html(<ReviewPage shell={shell} item={item} message={null} />);
  });

  app.get("/history", async (c) => {
    const shell = await loadShell(c, "History", "/history");
    const items = await listItems(c.env, ["posted", "posting", "needs_you"]);
    const rows = [];
    for (const item of items)
      rows.push({ item, audit: await listAudit(c.env, item.id) });
    return c.html(
      <HistoryPage
        shell={shell}
        items={rows}
        message={null}
        now={Date.now()}
        fetchTimeoutMs={xFetchTimeoutMs(c.env)}
      />,
    );
  });

  app.get("/settings", async (c) => settings(c, null, null));

  app.post("/items", async (c) => {
    try {
      const input = await draftFromForm(formOf(c));
      const saved = await createDraft(c.env, {
        ...input,
        source: "you",
        sourceRef: null,
        actor: actorOf(c),
        now: Date.now(),
      });
      await applyIntent(c, saved.item.id);
      return c.redirect(`/items/${saved.item.id}?notice=saved`, 303);
    } catch (error) {
      if (!(error instanceof AppError) || !htmlWanted(c)) throw error;
      const shell = await loadShell(c, "New draft", "/compose");
      const input = draftFromFormLoose(formOf(c));
      return c.html(
        <EditorPage
          shell={shell}
          item={null}
          errors={error.fields}
          message={error.message}
          {...input}
        />,
        error.statusCode as 400,
      );
    }
  });

  app.post("/items/:id", async (c) => saveExisting(c));
  app.post("/items/:id/split", async (c) => {
    await saveFormFirst(c);
    const item = await splitItem(c.env, idOf(c), actorOf(c), Date.now());
    return c.redirect(`/items/${item.id}?notice=saved`, 303);
  });
  app.post("/items/:id/make-article", async (c) => {
    await saveFormFirst(c);
    const item = await makeArticle(c.env, idOf(c), actorOf(c), Date.now());
    return c.redirect(`/items/${item.id}?notice=saved`, 303);
  });
  app.post("/items/:id/approve", (c) => approve(c, true));
  app.post("/items/:id/schedule", (c) => schedule(c, true));
  app.post("/items/:id/unschedule", (c) =>
    simpleAction(c, unscheduleItem, "/items/:id/review?notice=unscheduled"),
  );
  app.post("/items/:id/archive", (c) =>
    simpleAction(c, archiveItem, "/?notice=archived"),
  );
  app.post("/items/:id/retry", async (c) => {
    const raw = formText(formOf(c), "position");
    const position = raw === "" ? null : Number(raw);
    await retryItem(
      c.env,
      idOf(c),
      actorOf(c),
      Date.now(),
      Number.isInteger(position) ? position : null,
      formText(formOf(c), "confirm") === "yes",
    );
    return c.redirect("/history?notice=retry", 303);
  });
  app.post("/items/:id/mark-link", async (c) => {
    await markSegmentFromUrl(
      c.env,
      idOf(c),
      actorOf(c),
      Date.now(),
      formText(formOf(c), "status_url"),
    );
    return c.redirect("/history?notice=marked", 303);
  });
  app.post("/items/:id/reschedule", async (c) => {
    await rescheduleMissed(
      c.env,
      idOf(c),
      actorOf(c),
      Date.now(),
      scheduleFromForm(formOf(c), (await readPreferences(c.env)).timeZone),
    );
    return c.redirect(`/items/${idOf(c)}/review?notice=rescheduled`, 303);
  });
  app.post("/items/:id/delete", async (c) => {
    const id = idOf(c);
    if (!isUlid(id)) throw new AppError(404, "That draft is not here.");
    if (formText(formOf(c), "confirm") !== "yes") {
      throw new AppError(409, "Confirm before deleting.");
    }
    const deleted = await deleteItem(c.env, id, actorOf(c), Date.now());
    const back = formText(formOf(c), "back");
    const target =
      back === "queue"
        ? "/queue"
        : back === "history"
          ? "/history"
          : deleted.status === "archived"
            ? "/archived"
            : "/";
    return c.redirect(`${target}?notice=deleted`, 303);
  });
  app.post("/items/:id/restore", async (c) => {
    const item = await restoreItem(c.env, idOf(c), actorOf(c), Date.now());
    return c.redirect(`/items/${item.id}?notice=restored`, 303);
  });
  app.post("/settings/preferences", async (c) => {
    const raw = formText(formOf(c), "x_plan");
    const plan = raw === "" ? null : raw;
    if (plan !== null && !isXPlan(plan)) {
      return settings(c, null, "That X plan is not recognized.");
    }
    try {
      await savePreferences(
        c.env,
        formText(formOf(c), "time_zone").trim(),
        plan,
        (await publicAccount(c.env)).subscriptionType,
      );
    } catch (error) {
      if (error instanceof AppError) return settings(c, null, error.message);
      throw error;
    }
    return c.redirect("/settings?notice=preferences", 303);
  });
  app.post("/settings/pause", async (c) => {
    await pauseAllPosting(c.env, actorOf(c), Date.now());
    return c.redirect("/settings?notice=paused", 303);
  });
  app.post("/items/:id/post-now", async (c) => {
    const item = await postNowItem(c.env, idOf(c), actorOf(c), Date.now());
    return c.redirect(`/items/${item.id}/review?notice=scheduled`, 303);
  });
  app.post("/items/:id/mark-posted", async (c) => {
    await markPostedItem(c.env, idOf(c), actorOf(c), Date.now());
    return c.redirect("/history?notice=marked", 303);
  });

  app.post("/settings/tokens", async (c) => {
    const name = formText(formOf(c), "name");
    const fresh = await createNamedToken(c.env, name, Date.now());
    return settings(c, fresh, null);
  });
  app.post("/settings/tokens/:id/revoke", async (c) => {
    await revokeNamedToken(c.env, idOf(c), Date.now());
    return c.redirect("/settings", 303);
  });
  app.post("/settings/import", async (c) => {
    const file = formOf(c).file;
    if (!(file instanceof File))
      throw new AppError(422, "Choose the Buffer export file.");
    const body = JSON.parse(await file.text()) as unknown;
    const result = await importBuffer(c.env, body, actorOf(c), Date.now());
    return settings(
      c,
      null,
      `Imported ${result.created} drafts. ${result.existing} were already here.`,
    );
  });

  app.get("/avatar", async (c) => {
    const avatar = await readAvatar(c.env);
    if (!avatar) return c.notFound();
    return new Response(avatar.body, {
      headers: {
        "content-type": avatar.mime,
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
      },
    });
  });

  app.get("/archived", async (c) => {
    const shell = await loadShell(c, "Archived", "/archived");
    const items = await listItems(c.env, ["archived"]);
    return c.html(<ArchivedPage shell={shell} items={items} />);
  });

  app.get("/media/:id", async (c) => {
    const id = idOf(c);
    if (!isUlid(id)) return c.notFound();
    const row = await c.env.DB.prepare(
      "SELECT r2_key, mime FROM media WHERE id = ?",
    )
      .bind(id)
      .first<{ r2_key: string; mime: string }>();
    if (!row) return c.notFound();
    const object = await c.env.MEDIA.get(row.r2_key);
    if (!object) return c.notFound();
    return new Response(object.body, {
      headers: {
        "content-type": row.mime,
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
