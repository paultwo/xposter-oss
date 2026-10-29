import type { Child } from "hono/jsx";
import type { ItemRecord } from "../items/model";
import type { Kind } from "../lib/state";
import { overLimitCopy, weightedLength } from "../lib/text";
import { ErrorSummary, Layout } from "./layout";
import type { FieldErrors, Shell } from "./shell";
import { initials } from "./text";

type EditorSegment = {
  text: string;
  media: Array<{ id?: string; altText: string; mime?: string }>;
};

export function EditorPage(props: {
  shell: Shell;
  item: ItemRecord | null;
  kind: Kind;
  title: string;
  notes: string;
  segments: EditorSegment[];
  errors: FieldErrors;
  message: string | null;
}) {
  const over = props.segments.some(
    (segment) => weightedLength(segment.text) > props.shell.standardLimit,
  );
  const tooLong = props.segments.some(
    (segment) => weightedLength(segment.text) > props.shell.premiumLimit,
  );
  return (
    <Layout shell={props.shell}>
      <h1>{props.item ? "Edit draft" : "New draft"}</h1>
      <ErrorSummary message={props.message} />
      <div class="composer">
        <form
          method="post"
          action={props.item ? `/items/${props.item.id}` : "/items"}
          enctype="multipart/form-data"
        >
          <input type="hidden" name="csrf" value={props.shell.csrf} />
          <input
            type="hidden"
            name="segment_count"
            id="segment-count"
            value={String(props.segments.length)}
          />
          <div class="field">
            <label for="kind">Type</label>
            <select id="kind" name="kind">
              <option value="post" selected={props.kind === "post"}>
                Post
              </option>
              <option value="thread" selected={props.kind === "thread"}>
                Thread
              </option>
              <option value="article" selected={props.kind === "article"}>
                Article
              </option>
            </select>
          </div>
          <div class="field" id="title-field" hidden={props.kind !== "article"}>
            <label for="title">Title</label>
            <p id="title-hint" class="hint">
              Required for an Article. A post or thread does not post this.
            </p>
            <input
              id="title"
              name="title"
              type="text"
              value={props.title}
              maxlength={200}
              autocomplete="off"
              aria-describedby="title-hint"
            />
          </div>
          <div id="segments">
            {props.segments.map((segment, index) => (
              <SegmentFields
                index={index}
                total={props.segments.length}
                segment={segment}
                limit={
                  props.kind === "article"
                    ? props.shell.premiumLimit
                    : props.shell.postLimit
                }
                maxLength={props.shell.premiumLimit}
                errors={props.errors}
              />
            ))}
          </div>
          <template id="segment-template">
            {segmentTemplate(props.shell.premiumLimit, props.shell.postLimit)}
          </template>
          <p class="actions">
            <button type="button" id="add-segment" class="secondary">
              + Add post
            </button>
          </p>
          {props.kind !== "article" ? (
            <fieldset id="long-post-choices" hidden={!over}>
              <legend>
                {props.shell.longPosts
                  ? `Longer than ${props.shell.standardLimit.toLocaleString("en-US")} characters`
                  : `Over ${props.shell.standardLimit.toLocaleString("en-US")} characters`}
              </legend>
              {props.shell.longPosts ? (
                <p>
                  Keep it as a long post, split it into a thread, or make it an
                  Article.
                </p>
              ) : (
                <p>Long posts need X Premium.</p>
              )}
              <p class="actions">
                {props.shell.longPosts ? (
                  <button
                    type="submit"
                    id="keep-long"
                    name="intent"
                    value="long"
                    disabled={tooLong}
                    data-busy="Saving draft…"
                  >
                    Keep as a long post
                  </button>
                ) : null}
                {props.item ? (
                  <button
                    type="submit"
                    class={props.shell.longPosts ? "secondary" : undefined}
                    formaction={`/items/${props.item.id}/split`}
                    data-busy="Splitting…"
                  >
                    Split into a thread
                  </button>
                ) : (
                  <button
                    type="submit"
                    class={props.shell.longPosts ? "secondary" : undefined}
                    name="intent"
                    value="split"
                    data-busy="Splitting…"
                  >
                    Split into a thread
                  </button>
                )}
                {props.item ? (
                  <button
                    type="submit"
                    class="secondary"
                    formaction={`/items/${props.item.id}/make-article`}
                    data-busy="Making an Article…"
                  >
                    Make an Article
                  </button>
                ) : (
                  <button
                    type="submit"
                    class="secondary"
                    name="intent"
                    value="article"
                    data-busy="Making an Article…"
                  >
                    Make an Article
                  </button>
                )}
              </p>
              {props.shell.longPosts && tooLong ? (
                <p>
                  This is over the long-post limit of{" "}
                  {props.shell.premiumLimit.toLocaleString("en-US")} characters.
                </p>
              ) : null}
            </fieldset>
          ) : null}
          <div class="field">
            <label for="notes">Notes</label>
            <p id="notes-hint" class="hint">
              Not posted. Use this for reviewer notes.
            </p>
            <textarea
              id="notes"
              name="notes"
              rows={4}
              maxlength={5000}
              aria-describedby="notes-hint"
            >
              {props.notes}
            </textarea>
          </div>
          {props.item ? (
            <p>
              <a href={`/items/${props.item.id}/review`}>Review and approve</a>
            </p>
          ) : null}
          <p class="actions">
            <button type="submit" data-busy="Saving draft…">
              Save draft
            </button>
          </p>
        </form>
        <aside class="live-preview" aria-label="Preview on X">
          <h2>Preview</h2>
          <div id="live-preview"></div>
          <template id="live-post-template">
            <li class="x-post">
              <div class="x-frame">
                <p class="x-name">
                  {props.shell.account.avatar ? (
                    <img class="x-avatar" src="/avatar" alt="" />
                  ) : (
                    <span class="x-avatar" aria-hidden="true">
                      {initials(
                        props.shell.account.displayName,
                        props.shell.account.username,
                      )}
                    </span>
                  )}
                  <span class="x-display">
                    {props.shell.account.displayName ??
                      props.shell.account.username ??
                      "Not connected"}
                  </span>{" "}
                  {props.shell.account.username ? (
                    <span class="x-handle">
                      @{props.shell.account.username}
                    </span>
                  ) : null}
                </p>
                <p class="post-text" data-live="text"></p>
                <details class="x-more" data-live="more" hidden>
                  <summary>Show more</summary>
                  <p class="post-text" data-live="rest"></p>
                </details>
                <aside class="link-card" data-live="card" hidden>
                  <p class="link-card-host" data-live="host"></p>
                  <p class="link-card-path" data-live="path"></p>
                </aside>
                <figure class="x-media" data-live="figure" hidden>
                  <img alt="" data-live="img" />
                  <figcaption>
                    <span class="alt-badge">ALT</span>{" "}
                    <span data-live="alt"></span>
                  </figcaption>
                </figure>
              </div>
              <p class="count" data-live="count"></p>
            </li>
          </template>
        </aside>
      </div>
      <div id="limit-live" role="status" aria-live="polite"></div>
    </Layout>
  );
}

function SegmentFields(props: {
  index: number;
  total: number;
  segment: EditorSegment;
  limit: number;
  maxLength: number;
  errors: FieldErrors;
}) {
  const length = weightedLength(props.segment.text);
  const limitNumber = props.limit;
  const over = length > limitNumber;
  const described = `count-${props.index}`;
  const textError = props.errors[`text_${props.index}`];
  return (
    <fieldset>
      <legend>
        Post {props.index + 1} of {props.total}
      </legend>
      <div class="field">
        <label for={`text-${props.index}`}>Text. Required.</label>
        <textarea
          id={`text-${props.index}`}
          name={`text_${props.index}`}
          rows={6}
          maxlength={props.maxLength}
          autocomplete="off"
          aria-describedby={
            textError ? `${described} text-error-${props.index}` : described
          }
          aria-invalid={textError ? "true" : undefined}
          data-count={described}
        >
          {props.segment.text}
        </textarea>
        <p id={described} class={over ? "count over" : "count"}>
          {length.toLocaleString("en-US")} /{" "}
          {limitNumber.toLocaleString("en-US")}
          {over ? `. ${overLimitCopy(length, limitNumber)}` : ""}
        </p>
        {textError ? (
          <p id={`text-error-${props.index}`} class="field-error">
            {textError}
          </p>
        ) : null}
      </div>
      {props.segment.media.map((media, imageIndex) => (
        <ImageFields
          index={props.index}
          imageIndex={imageIndex}
          media={media}
          errors={props.errors}
        />
      ))}
      {props.segment.media.length === 0 ? (
        <ImageFields
          index={props.index}
          imageIndex={0}
          media={{ altText: "" }}
          errors={props.errors}
        />
      ) : null}
      {props.index > 0 ? (
        <button type="button" class="text-link remove-segment">
          Remove post {props.index + 1}
        </button>
      ) : null}
    </fieldset>
  );
}

function ImageFields(props: {
  index: number;
  imageIndex: number;
  media: { id?: string; altText: string };
  errors: FieldErrors;
}) {
  const altId = `alt-${props.index}-${props.imageIndex}`;
  const fileId = `file-${props.index}-${props.imageIndex}`;
  const altError = props.errors[`alt_${props.index}_${props.imageIndex}`];
  return (
    <div class="image-fields">
      {props.media.id ? (
        <img class="thumb" src={`/media/${props.media.id}`} alt="" />
      ) : (
        <img class="preview thumb" alt="" hidden />
      )}
      {props.media.id ? (
        <input
          type="hidden"
          name={`media_${props.index}_${props.imageIndex}`}
          value={props.media.id}
        />
      ) : null}
      <div class="field">
        <label for={fileId}>{props.media.id ? "Replace image" : "Image"}</label>
        <input
          id={fileId}
          name={`file_${props.index}_${props.imageIndex}`}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
        />
      </div>
      <div class="field">
        <label for={altId}>Alt text. Required when an image is attached.</label>
        <input
          id={altId}
          name={`alt_${props.index}_${props.imageIndex}`}
          type="text"
          value={props.media.altText}
          maxlength={1000}
          autocomplete="off"
          aria-invalid={altError ? "true" : undefined}
          aria-describedby={
            altError
              ? `alt-error-${props.index}-${props.imageIndex}`
              : undefined
          }
        />
        {altError ? (
          <p
            id={`alt-error-${props.index}-${props.imageIndex}`}
            class="field-error"
          >
            {altError}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function segmentTemplate(maxLength: number, limit: number): Child {
  return (
    <fieldset>
      <legend>Post __N__</legend>
      <div class="field">
        <label for="text-__I__">Text. Required.</label>
        <textarea
          id="text-__I__"
          name="text___I__"
          rows={6}
          maxlength={maxLength}
          autocomplete="off"
          data-count="count-__I__"
        ></textarea>
        <p id="count-__I__" class="count">
          0 / {limit.toLocaleString("en-US")}
        </p>
      </div>
      <div class="image-fields">
        <img class="preview thumb" alt="" hidden />
        <div class="field">
          <label for="file-__I__-0">Image</label>
          <input
            id="file-__I__-0"
            name="file___I___0"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
          />
        </div>
        <div class="field">
          <label for="alt-__I__-0">
            Alt text. Required when an image is attached.
          </label>
          <input
            id="alt-__I__-0"
            name="alt___I___0"
            type="text"
            maxlength={1000}
            autocomplete="off"
          />
        </div>
      </div>
      <button type="button" class="text-link remove-segment">
        Remove post __N__
      </button>
    </fieldset>
  );
}
