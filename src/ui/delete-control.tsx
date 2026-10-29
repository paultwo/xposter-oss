import { canDelete } from "../items/delete";
import type { ItemRecord } from "../items/model";
import type { Shell } from "./shell";
import { firstLine } from "./text";

function noun(item: ItemRecord): string {
  if (item.status === "scheduled") return "scheduled post";
  if (item.status === "approved") return "approved draft";
  if (item.status === "archived") return "archived draft";
  return "draft";
}

// A Delete button and its confirm dialog. Nothing is deleted until the
// person presses Delete inside the dialog. Items that posted, or might have,
// never get the button.
export function DeleteControl(props: {
  shell: Shell;
  item: ItemRecord;
  back?: "queue";
  label?: string;
}) {
  if (!canDelete(props.item)) return null;
  const dialogId = `delete-${props.item.id}`;
  const titleId = `delete-title-${props.item.id}`;
  const scheduled = props.item.status === "scheduled";
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
          {scheduled ? "It comes off the queue and will not post to X. " : ""}
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
