import { canDelete } from "../items/delete";
import type { ItemRecord } from "../items/model";
import type { Shell } from "./shell";
import { firstLine } from "./text";

function noun(item: ItemRecord): string {
  if (item.status === "scheduled") return "scheduled post";
  if (item.status === "approved") return "approved draft";
  if (item.status === "archived") return "archived draft";
  if (item.status === "needs_you") {
    return item.needsReason === "unknown" ? "unconfirmed post" : "failed post";
  }
  return "draft";
}

function consequence(item: ItemRecord): string {
  if (item.status === "scheduled") {
    return "It comes off the queue and will not post to X. ";
  }
  if (item.status !== "needs_you") return "";
  if (item.needsReason === "unknown") {
    return "It will not be sent again. X may already have it: deleting here does not remove anything from X, so check X first. ";
  }
  return "It will not be sent again. ";
}

// A Delete button and its confirm dialog. Nothing is deleted until the
// person presses Delete inside the dialog. Items that are posting, or have
// any part on X, never get the button.
export function DeleteControl(props: {
  shell: Shell;
  item: ItemRecord;
  back?: "queue" | "history";
  label?: string;
}) {
  if (!canDelete(props.item)) return null;
  const dialogId = `delete-${props.item.id}`;
  const titleId = `delete-title-${props.item.id}`;
  return (
    <>
      <button
        type="button"
        class="text-link danger-link open-dialog"
        data-dialog={dialogId}
        aria-label={`Delete: ${firstLine(props.item)}`}
        data-preview={firstLine(props.item)}
      >
        {props.label ?? "Delete"}
      </button>
      <dialog id={dialogId} aria-labelledby={titleId}>
        <h2 id={titleId}>Delete this {noun(props.item)}?</h2>
        {/* Filled from data-preview when the dialog opens, so the text is not on
            the page twice. */}
        <p class="quiet" data-preview-slot />
        <p>
          {consequence(props.item)}
          This can't be undone. Archive it instead if you might want it back.
        </p>
        <form method="post" action={`/items/${props.item.id}/delete`}>
          <input type="hidden" name="csrf" value={props.shell.csrf} />
          <input type="hidden" name="confirm" value="yes" />
          {props.back ? (
            <input type="hidden" name="back" value={props.back} />
          ) : null}
          <button type="submit" class="danger" data-busy="Deleting…">
            Delete
          </button>
          <button type="button" class="secondary close-dialog">
            Cancel
          </button>
        </form>
      </dialog>
    </>
  );
}
