import type { ItemRecord } from "../items/model";
import { DeleteControl } from "./delete-control";
import { Layout } from "./layout";
import type { Shell } from "./shell";
import { firstLine } from "./text";

export function ArchivedPage(props: { shell: Shell; items: ItemRecord[] }) {
  return (
    <Layout shell={props.shell}>
      <h1>Archived</h1>
      {props.items.length === 0 ? (
        <p>Nothing is archived.</p>
      ) : (
        <ul class="rows">
          {props.items.map((item) => (
            <li>
              <span>{firstLine(item)}</span>
              <form method="post" action={`/items/${item.id}/restore`}>
                <input type="hidden" name="csrf" value={props.shell.csrf} />
                <button type="submit">Restore</button>
              </form>
              <DeleteControl shell={props.shell} item={item} />
            </li>
          ))}
        </ul>
      )}
      <p>
        <a href="/">Back to drafts</a>
      </p>
    </Layout>
  );
}
