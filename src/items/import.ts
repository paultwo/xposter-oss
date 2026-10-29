import { sha256Hex } from "../lib/crypto";
import { postLimits } from "../lib/plan";
import type { Status } from "../lib/state";
import { weightedLength } from "../lib/text";
import { overLimitNote } from "./content";
import { createDraft } from "./drafts";
import { AppError } from "./model";

type BufferPost = {
  id?: unknown;
  text?: unknown;
  createdAt?: unknown;
  status?: unknown;
};

export async function importBuffer(
  env: Env,
  body: unknown,
  actor: string,
  now: number,
): Promise<{
  created: number;
  existing: number;
  items: Array<{
    id: string;
    sourceRef: string;
    textSha256: string;
    status: Status;
  }>;
}> {
  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray((body as { posts_open?: unknown }).posts_open)
  ) {
    throw new AppError(400, "The Buffer export needs a posts_open list.");
  }
  const posts = (body as { posts_open: BufferPost[] }).posts_open;
  let created = 0;
  let existing = 0;
  const items: Array<{
    id: string;
    sourceRef: string;
    textSha256: string;
    status: Status;
  }> = [];
  for (const post of posts) {
    if (typeof post.id !== "string" || typeof post.text !== "string") {
      throw new AppError(400, "Each Buffer draft needs an id and text.");
    }
    const standard = postLimits(env).standard;
    const over = weightedLength(post.text) > standard;
    const createdAt =
      typeof post.createdAt === "string" ? Date.parse(post.createdAt) : now;
    const saved = await createDraft(env, {
      kind: "post",
      title: null,
      notes: over ? overLimitNote(standard) : null,
      reviewedBy: null,
      segments: [{ text: post.text, media: [] }],
      source: "buffer-import",
      sourceRef: post.id,
      actor,
      now,
      createdAt: Number.isFinite(createdAt) ? createdAt : now,
    });
    if (saved.created) created += 1;
    else existing += 1;
    items.push({
      id: saved.item.id,
      sourceRef: post.id,
      textSha256: await sha256Hex(post.text),
      status: saved.item.status,
    });
  }
  return { created, existing, items };
}
