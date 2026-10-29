import type { Child } from "hono/jsx";
import type { ItemRecord, SegmentRecord } from "../items/model";
import { foldAt, overLimitCopy, textUrls, weightedLength } from "../lib/text";
import type { PublicAccount } from "../x/account";
import { firstLine, initials } from "./text";

export function PostHeader(props: { account: PublicAccount }) {
  const letters = initials(props.account.displayName, props.account.username);
  const display =
    props.account.displayName ??
    (props.account.username ? props.account.username : "Not connected");
  return (
    <p class="x-name">
      {props.account.avatar ? (
        <img class="x-avatar" src="/avatar" alt="" />
      ) : (
        <span class="x-avatar" aria-hidden="true">
          {letters}
        </span>
      )}
      <span class="x-display">{display}</span>{" "}
      {props.account.username ? (
        <span class="x-handle">@{props.account.username}</span>
      ) : null}
    </p>
  );
}

function More(props: { rest: string }) {
  return (
    <details class="x-more">
      <summary>Show more</summary>
      <p class="post-text">
        <LinkedText text={props.rest} />
      </p>
    </details>
  );
}

function LinkedText(props: { text: string }) {
  const urls = textUrls(props.text);
  if (urls.length === 0) return <>{props.text}</>;
  const parts: Child[] = [];
  let cursor = 0;
  for (const entry of urls) {
    const start = entry.indices[0];
    const end = entry.indices[1];
    if (start > cursor) parts.push(props.text.slice(cursor, start));
    parts.push(
      <a class="post-link" href={entry.url}>
        {props.text.slice(start, end)}
      </a>,
    );
    cursor = end;
  }
  if (cursor < props.text.length) parts.push(props.text.slice(cursor));
  return <>{parts}</>;
}

function LinkCard(props: { text: string }) {
  const first = textUrls(props.text)[0];
  if (!first) return null;
  let host = first.url;
  let path = "";
  try {
    const parsed = new URL(first.url);
    host = parsed.host;
    path = `${parsed.pathname}${parsed.search}`;
    if (path === "/") path = "";
  } catch {
    host = first.url;
  }
  return (
    <aside class="link-card">
      <p class="link-card-host">{host}</p>
      {path ? <p class="link-card-path">{path}</p> : null}
    </aside>
  );
}

function Count(props: { text: string; limit: number }) {
  const length = weightedLength(props.text);
  const limit = props.limit;
  const over = length > limit;
  return (
    <p class={over ? "count over" : "count"}>
      {length.toLocaleString("en-US")} / {limit.toLocaleString("en-US")}
      {over ? `. ${overLimitCopy(length, limit)}` : ""}
    </p>
  );
}

function Frame(props: {
  text: string;
  media: SegmentRecord["media"];
  account: PublicAccount;
  showMoreAt: number;
  title?: string | null;
}) {
  const folded = foldAt(props.text, props.showMoreAt);
  return (
    <div class="x-frame">
      <PostHeader account={props.account} />
      {props.title ? <p class="x-article-title">{props.title}</p> : null}
      <p class="post-text">
        <LinkedText text={folded.head} />
      </p>
      {folded.rest ? <More rest={folded.rest} /> : null}
      <LinkCard text={props.text} />
      {props.media.map((media) => (
        <figure class="x-media">
          <img src={`/media/${media.id}`} alt={media.altText} />
          <figcaption>
            <span class="alt-badge">ALT</span> {media.altText}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

export function XPreview(props: {
  item: ItemRecord;
  account: PublicAccount;
  limit: number;
  showMoreAt: number;
}) {
  const { item } = props;
  const statusHost = props.account.username
    ? `https://x.com/${props.account.username}/status/`
    : "https://x.com/i/status/";
  if (item.kind === "article") {
    const body = item.segments[0]?.text ?? "";
    return (
      <div class="x-preview">
        <div class="x-post">
          <Frame
            text={body}
            media={item.segments[0]?.media ?? []}
            account={props.account}
            showMoreAt={props.showMoreAt}
            title={item.title}
          />
          <p class="count">
            {weightedLength(body).toLocaleString("en-US")} /{" "}
            {props.limit.toLocaleString("en-US")}
          </p>
        </div>
      </div>
    );
  }
  const label =
    item.segments.length > 1 ? `Thread, ${item.segments.length} posts` : "Post";
  return (
    <ol class="x-preview" aria-label={label}>
      {item.segments.map((segment) => (
        <li
          class={item.segments.length > 1 ? "x-post threaded" : "x-post"}
          data-position={String(segment.position)}
        >
          <Frame
            text={segment.text}
            media={segment.media}
            account={props.account}
            showMoreAt={props.showMoreAt}
          />
          <Count text={segment.text} limit={props.limit} />
          {segment.xPostId ? (
            <p>
              <a class="text-action" href={`${statusHost}${segment.xPostId}`}>
                View post {segment.position + 1} on X
              </a>
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function previewLabel(item: ItemRecord): string {
  return firstLine(item);
}
