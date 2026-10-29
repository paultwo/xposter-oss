import { approvalBlocker } from "../items/approval";
import type { ItemRecord } from "../items/model";
import {
  type Bucket,
  bucketOf,
  FILTERS,
  type Filter,
  filterLabel,
  matchesFilter,
} from "../lib/dashboard";
import { formatEt, formatUpdated } from "../lib/time";
import { DeleteControl } from "./delete-control";
import { Layout } from "./layout";
import { XPreview } from "./preview";
import type { Shell } from "./shell";
import { firstLine, missedCopy, unknownCopy } from "./text";

const EMPTY: Record<Filter, string> = {
  all: "No drafts yet. Write one, import from Buffer in Settings, or wait for a bot to send one.",
  needs_you: "Nothing needs you.",
  draft: "No plain drafts.",
  needs_hemingway: "Nothing is in review.",
  needs_approval: "Nothing needs your approval.",
  approved: "Nothing is approved and unscheduled.",
  scheduled: "Nothing is scheduled.",
  posted: "Nothing has posted from here yet.",
};

function attentionLabel(item: ItemRecord): string {
  if (item.missed) return "Missed";
  if (item.status === "needs_you" && item.needsReason === "rejected") {
    return item.segments.some((segment) => segment.xPostId)
      ? "Partly posted"
      : "Failed";
  }
  return "Needs you";
}

function sourceLabel(source: string): string {
  if (source === "you") return "Written by you";
  if (source === "buffer-import") return "Imported from Buffer";
  if (source === "env:intake") return "Sent by x-drafts";
  return "Sent by a bot";
}

function kindLabel(item: ItemRecord): string {
  if (item.kind === "article") return "Article";
  if (item.kind === "thread") return `Thread, ${item.segments.length} posts`;
  return "Post";
}

function stageText(bucket: Bucket, item: ItemRecord): string {
  if (bucket === "scheduled" && item.status === "posting") return "Posting";
  switch (bucket) {
    case "needs_you":
      return attentionLabel(item);
    case "draft":
    case "needs_hemingway":
    case "needs_approval":
    case "approved":
    case "scheduled":
    case "posted":
      return filterLabel(bucket);
    case "archived":
      return "Archived";
    default: {
      const neverBucket: never = bucket;
      return neverBucket;
    }
  }
}

function needsYouCopy(items: ItemRecord[], timeZone: string): string {
  const count = items.length;
  const head = `${count} post${count === 1 ? "" : "s"} ${count === 1 ? "needs" : "need"} you.`;
  const item = items[0];
  if (!item || count !== 1) return `${head} Check them.`;
  if (item.missed && item.scheduledAt) {
    return `${head} It was due ${formatEt(item.scheduledAt, timeZone)} and did not post. Check it.`;
  }
  if (item.status === "needs_you" && item.needsReason === "unknown") {
    return `${head} ${unknownCopy(item, timeZone)}`;
  }
  if (item.status === "needs_you" && item.needsReason === "rejected") {
    if (item.segments.some((segment) => segment.xPostId)) {
      return `${head} Part of it is already on X. Check it.`;
    }
    return `${head} ${item.lastError ?? "It failed."} Check it.`;
  }
  return `${head} Check it.`;
}

export function DashboardPage(props: {
  shell: Shell;
  filter: Filter;
  items: ItemRecord[];
}) {
  const now = Date.now();
  const buckets = props.items.map((item) => ({
    item,
    bucket: bucketOf(item.status, item.reviewStage, item.missed),
  }));
  const shown = buckets.filter((entry) =>
    matchesFilter(props.filter, entry.bucket),
  );
  const attention = buckets
    .filter((entry) => entry.bucket === "needs_you")
    .map((entry) => entry.item);
  const bannerHref =
    attention.length === 1 && attention[0]
      ? `#item-${attention[0].id}`
      : "/?status=needs_you";
  return (
    <Layout shell={props.shell}>
      <h1>Drafts</h1>
      <p class="lede">
        Any edit sends it back to draft. Approving does not schedule or post.
      </p>
      {attention.length > 0 ? (
        <p class="banner">
          <a href={bannerHref}>
            {needsYouCopy(attention, props.shell.timeZone)}
          </a>
        </p>
      ) : null}
      <nav aria-label="Filter by status" class="filters">
        <ul>
          {FILTERS.map((filter) => {
            const count = buckets.filter((entry) =>
              matchesFilter(filter, entry.bucket),
            ).length;
            return (
              <li>
                <a
                  href={filter === "all" ? "/" : `/?status=${filter}`}
                  aria-current={props.filter === filter ? "page" : undefined}
                >
                  {filterLabel(filter)} <span class="tally">{count}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
      <h2 class="vh">{filterLabel(props.filter)}</h2>
      {shown.length === 0 ? (
        <div class="empty">
          <p>{EMPTY[props.filter]}</p>
          {props.items.length === 0 ? (
            <p class="actions">
              <a class="button" href="/compose">
                New draft
              </a>
              {props.shell.account.connected ? null : (
                <a class="button secondary" href="/oauth/x/start">
                  Connect X
                </a>
              )}
            </p>
          ) : null}
        </div>
      ) : (
        <ul class="drafts">
          {shown.map(({ item, bucket }) => (
            <DraftEntry
              item={item}
              bucket={bucket}
              filter={props.filter}
              shell={props.shell}
              now={now}
            />
          ))}
        </ul>
      )}
      <p>
        <a href="/archived">Archived</a>
      </p>
    </Layout>
  );
}

function DraftEntry(props: {
  item: ItemRecord;
  bucket: ReturnType<typeof bucketOf>;
  filter: Filter;
  shell: Shell;
  now: number;
}) {
  const { item } = props;
  const headingId = `item-${item.id}-heading`;
  const line = firstLine(item);
  const blocker =
    item.status === "draft"
      ? approvalBlocker(item, props.shell.plan, {
          standard: props.shell.standardLimit,
          premium: props.shell.premiumLimit,
          showMoreAt: props.shell.showMoreAt,
        })
      : null;
  const editable =
    item.status === "draft" ||
    item.status === "approved" ||
    item.status === "scheduled" ||
    (item.status === "needs_you" &&
      item.needsReason === "rejected" &&
      !item.segments.some((segment) => segment.xPostId));
  const label = stageText(props.bucket, item);
  return (
    <li id={`item-${item.id}`} class="draft-entry">
      <article aria-labelledby={headingId}>
        <header class="entry-meta">
          <h3 id={headingId}>
            <span class={`stage stage-${props.bucket}`}>{label}</span>{" "}
            <span class="entry-kind">{kindLabel(item)}</span>
          </h3>
          <p class="quiet">
            {sourceLabel(item.source)}.{" "}
            {item.missed && item.scheduledAt ? (
              missedCopy(item.scheduledAt, props.shell.timeZone)
            ) : item.status === "needs_you" &&
              item.needsReason === "unknown" ? (
              <span class="when outcome">
                {unknownCopy(item, props.shell.timeZone)}
              </span>
            ) : (
              <span class="when">
                {item.scheduledAt && props.bucket === "scheduled"
                  ? `Posts ${formatEt(item.scheduledAt, props.shell.timeZone)}.`
                  : `Updated ${formatUpdated(props.now, item.updatedAt, props.shell.timeZone)}.`}
              </span>
            )}
          </p>
        </header>
        <div class="entry-actions">
          {item.status === "draft" && !blocker ? (
            <form method="post" action={`/items/${item.id}/approve`}>
              <input type="hidden" name="csrf" value={props.shell.csrf} />
              <input
                type="hidden"
                name="expected_hash"
                value={item.contentHash}
              />
              <input type="hidden" name="back" value={props.filter} />
              <button
                type="submit"
                data-busy="Approving…"
                aria-label={`Approve: ${line}`}
              >
                Approve
              </button>
            </form>
          ) : null}
          {editable ? (
            <a
              class="button secondary"
              href={`/items/${item.id}`}
              aria-label={`Edit: ${line}`}
            >
              Edit
            </a>
          ) : null}
          {item.missed ? (
            <a
              class="text-action"
              href={`/items/${item.id}/review`}
              aria-label={`Reschedule: ${line}`}
            >
              Reschedule
            </a>
          ) : null}
          {(item.status === "approved" || item.status === "scheduled") &&
          !item.missed ? (
            <a
              class="text-action"
              href={`/items/${item.id}/review`}
              aria-label={`${item.status === "approved" ? "Schedule" : "Review"}: ${line}`}
            >
              {item.status === "approved" ? "Schedule" : "Review"}
            </a>
          ) : null}
          {props.bucket === "needs_you" && !item.missed ? (
            <a
              class="text-action"
              href="/history"
              aria-label={`Open in history: ${line}`}
            >
              Open in history
            </a>
          ) : null}
          <DeleteControl shell={props.shell} item={item} />
          {blocker ? <p class="blocker">{blocker}</p> : null}
        </div>
        <XPreview
          item={item}
          account={props.shell.account}
          limit={
            item.kind === "article"
              ? props.shell.premiumLimit
              : props.shell.postLimit
          }
          showMoreAt={props.shell.showMoreAt}
        />
        {item.notes ? (
          <p class="entry-notes">
            <strong>Your note (not posted):</strong> {item.notes}
          </p>
        ) : null}
      </article>
    </li>
  );
}
