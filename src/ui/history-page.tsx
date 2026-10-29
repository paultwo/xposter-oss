import type { ItemRecord } from "../items/model";
import { statusLabel } from "../lib/state";
import { formatEt } from "../lib/time";
import { DeleteControl } from "./delete-control";
import { ErrorSummary, Layout } from "./layout";
import type { Shell } from "./shell";
import { firstLine, unknownCopy } from "./text";

export type AuditRow = {
  actor: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  at: number;
};

export function HistoryPage(props: {
  shell: Shell;
  items: Array<{ item: ItemRecord; audit: AuditRow[] }>;
  message: string | null;
  now: number;
  fetchTimeoutMs: number;
}) {
  return (
    <Layout shell={props.shell}>
      <h1>History</h1>
      <ErrorSummary message={props.message} />
      {props.items.length === 0 ? (
        <p>Nothing has been posted from here.</p>
      ) : (
        <ul class="history">
          {props.items.map(({ item, audit }) => (
            <li>
              <h2>{firstLine(item)}</h2>
              <p>
                {item.status === "needs_you" ? (
                  <span class="stage stage-needs_you">Needs you</span>
                ) : (
                  <span class="status">{statusLabel(item.status)}</span>
                )}{" "}
                <time
                  datetime={new Date(
                    item.postedAt ?? item.updatedAt,
                  ).toISOString()}
                >
                  {formatEt(
                    item.postedAt ?? item.updatedAt,
                    props.shell.timeZone,
                  )}
                </time>
              </p>
              {item.status === "needs_you" ? (
                <>
                  <NeedsYou
                    item={item}
                    csrf={props.shell.csrf}
                    username={props.shell.account.username}
                    timeZone={props.shell.timeZone}
                    now={props.now}
                    fetchTimeoutMs={props.fetchTimeoutMs}
                  />
                  <p class="actions">
                    <DeleteControl
                      shell={props.shell}
                      item={item}
                      back="history"
                    />
                  </p>
                </>
              ) : item.status === "posting" ? (
                <p>{openOnX(props.shell.account.username)}</p>
              ) : (
                <>
                  {item.lastError ? <p>{item.lastError}</p> : null}
                  <ul class="posted-links">
                    {item.segments.map((segment) =>
                      segment.xPostId ? (
                        <li>
                          <a
                            class="text-action"
                            href={statusHref(
                              props.shell.account.username,
                              segment.xPostId,
                            )}
                          >
                            View post {segment.position + 1} on X
                          </a>
                        </li>
                      ) : null,
                    )}
                  </ul>
                </>
              )}
              <details>
                <summary>Audit trail</summary>
                <ol>
                  {audit.map((row) => (
                    <li>
                      {formatEt(row.at, props.shell.timeZone)} {row.actor}{" "}
                      {row.action}
                      {row.fromStatus && row.toStatus
                        ? ` ${row.fromStatus} to ${row.toStatus}`
                        : ""}
                    </li>
                  ))}
                </ol>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
}

function openOnX(username: string | null) {
  const href = username ? `https://x.com/${username}` : "https://x.com";
  const label = username ? `Open @${username} on X` : "Open on X";
  return (
    <a class="button secondary" href={href}>
      {label}
    </a>
  );
}

function statusHref(username: string | null, postId: string): string {
  return username
    ? `https://x.com/${username}/status/${postId}`
    : `https://x.com/i/status/${postId}`;
}

function NeedsYou(props: {
  item: ItemRecord;
  csrf: string;
  username: string | null;
  timeZone: string;
  now: number;
  fetchTimeoutMs: number;
}) {
  const missing = props.item.segments.find((segment) => !segment.xPostId);
  const postNumber = (missing?.position ?? 0) + 1;
  const live = props.item.segments.some((segment) => segment.xPostId);
  const resendAt =
    props.item.leaseUntil === null
      ? 0
      : props.item.leaseUntil + props.fetchTimeoutMs;
  const sendAgainReady = props.now >= resendAt;
  if (props.item.needsReason === "rejected") {
    return (
      <div class="needs-you">
        <h3>{props.item.lastError ?? "X rejected this post."}</h3>
        <p>{openOnX(props.username)}</p>
        {missing ? (
          <div>
            <p class="actions spaced">
              <button
                type="button"
                class="secondary open-resend"
                data-dialog={`resume-${props.item.id}`}
              >
                {live
                  ? "Resume the remaining posts"
                  : `Send post ${postNumber} again`}
              </button>
            </p>
            <dialog
              id={`resume-${props.item.id}`}
              aria-labelledby={`resume-title-${props.item.id}`}
            >
              <h3 id={`resume-title-${props.item.id}`}>
                {live
                  ? "Resume the remaining posts?"
                  : `Send post ${postNumber} again?`}
              </h3>
              <p>
                Only this post is sent next. You can't undo a post from here.
              </p>
              <form method="post" action={`/items/${props.item.id}/retry`}>
                <input type="hidden" name="csrf" value={props.csrf} />
                <input type="hidden" name="confirm" value="yes" />
                <input
                  type="hidden"
                  name="position"
                  value={String(missing.position)}
                />
                <button type="submit" class="danger" data-busy="Sending…">
                  {live
                    ? "Resume the remaining posts"
                    : `Send post ${postNumber} again`}
                </button>
                <button type="button" class="secondary close-resend">
                  Cancel
                </button>
              </form>
            </dialog>
          </div>
        ) : null}
        {live ? (
          <>
            <form method="post" action={`/items/${props.item.id}/mark-posted`}>
              <input type="hidden" name="csrf" value={props.csrf} />
              <button type="submit">Mark this item posted</button>
            </form>
            <p class="actions spaced">
              <button
                type="button"
                class="secondary open-resend"
                data-dialog={`archive-rest-${props.item.id}`}
              >
                Archive the unsent remainder
              </button>
            </p>
            <dialog
              id={`archive-rest-${props.item.id}`}
              aria-labelledby={`archive-rest-title-${props.item.id}`}
            >
              <h3 id={`archive-rest-title-${props.item.id}`}>
                Archive the unsent remainder?
              </h3>
              <p>
                Posts already on X stay up. The unsent posts will not be sent.
              </p>
              <form method="post" action={`/items/${props.item.id}/archive`}>
                <input type="hidden" name="csrf" value={props.csrf} />
                <button type="submit">Archive the unsent remainder</button>
                <button type="button" class="secondary close-resend">
                  Cancel
                </button>
              </form>
            </dialog>
          </>
        ) : (
          <p>
            <a href={`/items/${props.item.id}`}>Edit</a>
          </p>
        )}
      </div>
    );
  }
  return (
    <div class="needs-you">
      <h3>{unknownCopy(props.item, props.timeZone)}</h3>
      {missing ? <p class="post-text">{missing.text}</p> : null}
      <p>{openOnX(props.username)}</p>
      <form method="post" action={`/items/${props.item.id}/mark-link`}>
        <input type="hidden" name="csrf" value={props.csrf} />
        <div class="field">
          <label for={`link-${props.item.id}`}>Post link</label>
          <input
            id={`link-${props.item.id}`}
            name="status_url"
            type="url"
            required
            autocomplete="off"
            placeholder={
              props.username
                ? `https://x.com/${props.username}/status/123`
                : "https://x.com/username/status/123"
            }
          />
        </div>
        <button type="submit">It posted (paste its link)</button>
      </form>
      {props.item.kind === "article" ? (
        <p>
          This Article might already be on X. Paste its link. It will not be
          published again.
        </p>
      ) : missing && sendAgainReady ? (
        <div>
          <p class="actions spaced">
            <button
              type="button"
              class="secondary open-resend"
              data-dialog={`resend-${props.item.id}`}
            >
              It didn't post. Send post {postNumber} again
            </button>
          </p>
          <dialog
            id={`resend-${props.item.id}`}
            aria-labelledby={`resend-title-${props.item.id}`}
          >
            <h3 id={`resend-title-${props.item.id}`}>
              Send post {postNumber} again?
            </h3>
            <p>
              Only post {postNumber} is sent. Posts already on X are left alone.
              You can't undo a post from here.
            </p>
            <form method="post" action={`/items/${props.item.id}/retry`}>
              <input type="hidden" name="csrf" value={props.csrf} />
              <input type="hidden" name="confirm" value="yes" />
              <input
                type="hidden"
                name="position"
                value={String(missing.position)}
              />
              <button type="submit" class="danger" data-busy="Sending…">
                It didn't post. Send post {postNumber} again
              </button>
              <button type="button" class="secondary close-resend">
                Cancel
              </button>
            </form>
          </dialog>
        </div>
      ) : null}
    </div>
  );
}
