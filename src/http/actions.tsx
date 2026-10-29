import { listNamedTokens } from "../auth/intake";
import { AppError, type ItemRecord } from "../items/model";
import {
  approveItem,
  makeArticle,
  scheduleItem,
  splitItem,
  updateDraft,
} from "../items/service";
import { getItem } from "../items/store";
import { parseFilter } from "../lib/dashboard";
import { readPreferences } from "../lib/settings";
import { isUlid } from "../lib/ulid";
import { EditorPage, SettingsPage } from "../ui/pages";
import { draftFromForm, scheduleFromForm, segmentIndexes } from "./parse";
import { presentItem } from "./present";
import {
  actorOf,
  formOf,
  formText,
  htmlWanted,
  idOf,
  loadShell,
} from "./shell";
import type { AppContext, FormMap } from "./types";

export async function requireItem(c: AppContext): Promise<ItemRecord> {
  const id = idOf(c);
  if (!isUlid(id)) throw new AppError(404, "That draft is not here.");
  const item = await getItem(c.env, id);
  if (!item || item.status === "archived")
    throw new AppError(404, "That draft is not here.");
  return item;
}

export async function settings(
  c: AppContext,
  freshToken: string | null,
  message: string | null,
) {
  const shell = await loadShell(c, "Settings", "/settings");
  const tokens = await listNamedTokens(c.env);
  return c.html(
    <SettingsPage
      shell={shell}
      tokens={tokens}
      freshToken={freshToken}
      message={message}
    />,
  );
}

export async function applyIntent(c: AppContext, id: string): Promise<void> {
  const intent = formText(formOf(c), "intent");
  if (intent === "split") {
    await splitItem(c.env, id, actorOf(c), Date.now());
    return;
  }
  if (intent === "article") {
    await makeArticle(c.env, id, actorOf(c), Date.now());
  }
}

export async function saveFormFirst(c: AppContext): Promise<void> {
  const form = formOf(c);
  if (!("text_0" in form)) return;
  await updateDraft(
    c.env,
    idOf(c),
    await draftFromForm(form),
    actorOf(c),
    Date.now(),
  );
}

export async function saveExisting(c: AppContext) {
  try {
    const input = await draftFromForm(formOf(c));
    const item = await updateDraft(
      c.env,
      idOf(c),
      input,
      actorOf(c),
      Date.now(),
    );
    await applyIntent(c, item.id);
    return c.redirect(`/items/${item.id}?notice=saved`, 303);
  } catch (error) {
    if (!(error instanceof AppError) || !htmlWanted(c)) throw error;
    const shell = await loadShell(c, "Edit draft", "");
    const current = await getItem(c.env, idOf(c));
    return c.html(
      <EditorPage
        shell={shell}
        item={current}
        errors={error.fields}
        message={error.message}
        {...draftFromFormLoose(formOf(c))}
      />,
      error.statusCode as 400,
    );
  }
}

export async function approve(c: AppContext, asHtml: boolean) {
  const expected = asHtml
    ? formText(formOf(c), "expected_hash")
    : ((await c.req.json<{ expected_hash?: string }>()).expected_hash ?? "");
  const item = await approveItem(
    c.env,
    idOf(c),
    actorOf(c),
    Date.now(),
    expected,
  );
  if (!asHtml) return c.json({ item: presentItem(item) });
  const back = formText(formOf(c), "back");
  if (back) {
    const filter = parseFilter(back);
    const query = filter === "all" ? "" : `status=${filter}&`;
    return c.redirect(`/?${query}notice=approved#item-${item.id}`, 303);
  }
  return c.redirect(`/items/${item.id}/review?notice=approved`, 303);
}

export async function schedule(c: AppContext, asHtml: boolean) {
  const when = asHtml
    ? scheduleFromForm(formOf(c), (await readPreferences(c.env)).timeZone)
    : Number((await c.req.json<{ scheduled_at?: number }>()).scheduled_at);
  const item = await scheduleItem(c.env, idOf(c), actorOf(c), Date.now(), when);
  if (!asHtml) return c.json({ item: presentItem(item) });
  return c.redirect(`/items/${item.id}/review?notice=scheduled`, 303);
}

export async function simpleAction(
  c: AppContext,
  run: (
    env: Env,
    id: string,
    actor: string,
    now: number,
  ) => Promise<ItemRecord>,
  location: string,
) {
  const id = idOf(c);
  await run(c.env, id, actorOf(c), Date.now());
  return c.redirect(location.replace(":id", id), 303);
}

export function draftFromFormLoose(form: FormMap): {
  kind: "post" | "thread" | "article";
  title: string;
  notes: string;
  segments: Array<{
    text: string;
    media: Array<{ id?: string; altText: string }>;
  }>;
} {
  const kindValue = formText(form, "kind");
  const kind =
    kindValue === "thread" || kindValue === "article" ? kindValue : "post";
  const segments = [];
  for (const index of segmentIndexes(form)) {
    const text = formText(form, `text_${index}`);
    const alt = formText(form, `alt_${index}_0`);
    const existing = formText(form, `media_${index}_0`);
    if (!text && !alt && !existing && index > 0) continue;
    segments.push({
      text,
      media:
        alt || existing ? [{ id: existing || undefined, altText: alt }] : [],
    });
  }
  if (segments.length === 0) segments.push({ text: "", media: [] });
  return {
    kind,
    title: formText(form, "title"),
    notes: formText(form, "notes"),
    segments,
  };
}
