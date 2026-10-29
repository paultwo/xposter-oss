import type { ItemRecord } from "../items/model";
import { costLine, estimateCost } from "../lib/cost";
import type { Kind } from "../lib/state";
import { formatEt } from "../lib/time";
import { DeleteControl } from "./delete-control";
import { ErrorSummary, Layout } from "./layout";
import { XPreview } from "./preview";
import type { Shell } from "./shell";
import { firstLine, missedCopy } from "./text";

function approveLabel(kind: Kind): string {
  if (kind === "thread") return "Approve thread";
  if (kind === "article") return "Approve Article";
  return "Approve post";
}

function kindNoun(kind: Kind): string {
  if (kind === "article") return "Article";
  if (kind === "thread") return "thread";
  return "post";
}

export function ReviewPage(props: {
  shell: Shell;
  item: ItemRecord;
  message: string | null;
}) {
  const cost = estimateCost(
    props.item.kind,
    props.item.segments.map((segment) => ({
      text: segment.text,
      altCount: segment.media.length,
      hasMedia: segment.media.length > 0,
    })),
  );
  const username = props.shell.account.username;
  const zone = props.shell.timeZoneLabel;
  return (
    <Layout shell={props.shell}>
      <h1>Review</h1>
      <ErrorSummary message={props.message} />
      <p>
        Goes to {username ? `@${username}` : "the connected account"}. Approving
        doesn't post or schedule it. You'll pick a time next.
      </p>
      <div data-first-line={firstLine(props.item)}>
        <XPreview
          item={props.item}
          account={props.shell.account}
          limit={
            props.item.kind === "article"
              ? props.shell.premiumLimit
              : props.shell.postLimit
          }
          showMoreAt={props.shell.showMoreAt}
        />
      </div>
      {props.item.notes ? (
        <p>
          <strong>Your note (not posted):</strong> {props.item.notes}
        </p>
      ) : null}
      <p>
        <a href={`/items/${props.item.id}`}>Back to the draft</a>
      </p>
      {props.item.status === "draft" ? (
        <form method="post" action={`/items/${props.item.id}/approve`}>
          <input type="hidden" name="csrf" value={props.shell.csrf} />
          <input
            type="hidden"
            name="expected_hash"
            value={props.item.contentHash}
          />
          <button type="submit" data-busy="Approving…">
            {approveLabel(props.item.kind)}
          </button>
          <p class="cost-line">{costLine(cost)}</p>
        </form>
      ) : null}
      {props.item.status === "approved" ? (
        <>
          <form
            method="post"
            action={`/items/${props.item.id}/schedule`}
            class="schedule"
          >
            <input type="hidden" name="csrf" value={props.shell.csrf} />
            <div class="field">
              <label for="schedule-date">Date ({zone}). Required.</label>
              <input
                id="schedule-date"
                name="date"
                type="date"
                required
                autocomplete="off"
              />
            </div>
            <div class="field">
              <label for="schedule-time">Time ({zone}). Required.</label>
              <input
                id="schedule-time"
                name="time"
                type="time"
                step={60}
                required
                autocomplete="off"
              />
            </div>
            <button type="submit" data-busy="Scheduling…">
              Schedule
            </button>
          </form>
          <p class="actions spaced">
            <button
              type="button"
              class="secondary"
              id="open-post-now"
              data-count={String(props.item.segments.length)}
              data-kind={props.item.kind}
              data-user={username ?? ""}
              data-zone={props.shell.timeZone}
            >
              Post in 60 seconds
            </button>
          </p>
        </>
      ) : null}
      {props.item.missed && props.item.scheduledAt ? (
        <form
          method="post"
          action={`/items/${props.item.id}/reschedule`}
          class="schedule"
        >
          <input type="hidden" name="csrf" value={props.shell.csrf} />
          <p>{missedCopy(props.item.scheduledAt, props.shell.timeZone)}</p>
          <div class="field">
            <label for="reschedule-date">New date ({zone}). Required.</label>
            <input
              id="reschedule-date"
              name="date"
              type="date"
              required
              autocomplete="off"
            />
          </div>
          <div class="field">
            <label for="reschedule-time">New time ({zone}). Required.</label>
            <input
              id="reschedule-time"
              name="time"
              type="time"
              step={60}
              required
              autocomplete="off"
            />
          </div>
          <button type="submit">Reschedule</button>
        </form>
      ) : null}
      {props.item.status === "scheduled" &&
      props.item.scheduledAt &&
      !props.item.missed ? (
        <form method="post" action={`/items/${props.item.id}/unschedule`}>
          <input type="hidden" name="csrf" value={props.shell.csrf} />
          <p>
            Scheduled for{" "}
            <time datetime={new Date(props.item.scheduledAt).toISOString()}>
              {formatEt(props.item.scheduledAt, props.shell.timeZone)}
            </time>
            .
          </p>
          <button type="submit" data-busy="Unscheduling…">
            Unschedule
          </button>
        </form>
      ) : null}
      {props.item.status === "draft" ||
      props.item.status === "approved" ||
      props.item.status === "scheduled" ||
      props.item.status === "needs_you" ? (
        <p class="actions">
          <button type="button" class="text-link" id="open-archive">
            Archive
          </button>{" "}
          <DeleteControl shell={props.shell} item={props.item} />
        </p>
      ) : null}
      <dialog id="post-now" aria-labelledby="post-now-title">
        <h2 id="post-now-title">
          {username
            ? `Post this ${kindNoun(props.item.kind)} to @${username} now?`
            : `Post this ${kindNoun(props.item.kind)} now?`}
        </h2>
        <p id="post-now-line"></p>
        <form method="post" action={`/items/${props.item.id}/post-now`}>
          <input type="hidden" name="csrf" value={props.shell.csrf} />
          <button type="submit" class="danger" data-busy="Scheduling…">
            Post in 60 seconds
          </button>
          <button type="button" class="secondary" id="close-post-now">
            Cancel
          </button>
        </form>
      </dialog>
      <dialog id="archive-dialog" aria-labelledby="archive-title">
        <h2 id="archive-title">Archive this draft?</h2>
        <p>
          This draft moves to Archived. You can open it from the Drafts page.
        </p>
        <form method="post" action={`/items/${props.item.id}/archive`}>
          <input type="hidden" name="csrf" value={props.shell.csrf} />
          <button type="submit">Archive</button>
          <button type="button" class="secondary" id="close-archive">
            Cancel
          </button>
        </form>
      </dialog>
    </Layout>
  );
}
