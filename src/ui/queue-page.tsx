import type { ItemRecord } from "../items/model";
import { statusLabel } from "../lib/state";
import { type EtDay, formatEt } from "../lib/time";
import { DeleteControl } from "./delete-control";
import { Layout } from "./layout";
import type { Shell } from "./shell";
import { firstLine, missedCopy } from "./text";

export function QueuePage(props: {
  shell: Shell;
  days: EtDay[];
  items: ItemRecord[];
}) {
  const unscheduled = props.items.filter(
    (item) => item.status === "draft" || item.status === "approved",
  );
  const sending = props.items.filter((item) => item.status === "posting");
  const missed = props.items
    .filter(
      (item) =>
        item.status === "scheduled" && item.missed && item.scheduledAt !== null,
    )
    .sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0));
  return (
    <Layout shell={props.shell}>
      <h1>Queue</h1>
      {missed.length > 0 ? (
        <section>
          <h2>Missed</h2>
          <DayList items={missed} shell={props.shell} />
        </section>
      ) : null}
      <section>
        <h2>This week</h2>
        {props.days.every(
          (day) => scheduledOn(props.items, day).length === 0,
        ) ? (
          <p>Nothing scheduled this week.</p>
        ) : (
          <ol class="week">
            {props.days.map((day) => {
              const scheduled = scheduledOn(props.items, day);
              return (
                <li id={`day-${day.key}`}>
                  <h3>{day.label}</h3>
                  {scheduled.length === 0 ? (
                    <p class="quiet">Nothing scheduled.</p>
                  ) : (
                    <DayList items={scheduled} shell={props.shell} />
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>
      {sending.length > 0 ? (
        <section>
          <h2>Sending</h2>
          <ItemList items={sending} shell={props.shell} />
        </section>
      ) : null}
      <section>
        <h2>Not scheduled</h2>
        {unscheduled.length === 0 && props.items.length === 0 ? (
          <p>No drafts yet. Write one, or wait for a bot to send one.</p>
        ) : unscheduled.length === 0 ? (
          <p>Nothing is waiting. Scheduled posts are on the week above.</p>
        ) : (
          <ItemList items={unscheduled} shell={props.shell} />
        )}
        <p>
          <a class="button" href="/compose">
            New draft
          </a>
        </p>
      </section>
    </Layout>
  );
}

function scheduledOn(items: ItemRecord[], day: EtDay): ItemRecord[] {
  return items.filter(
    (item) =>
      item.status === "scheduled" &&
      !item.missed &&
      item.scheduledAt !== null &&
      item.scheduledAt >= day.start &&
      item.scheduledAt < day.end,
  );
}

function DayList(props: { items: ItemRecord[]; shell: Shell }) {
  return (
    <ul class="rows">
      {props.items.map((item) => (
        <li>
          <a class="text-action" href={`/items/${item.id}/review`}>
            {firstLine(item)}
          </a>
          {item.missed && item.scheduledAt ? (
            <>
              <span class="stage stage-needs_you">Missed</span>
              <p>{missedCopy(item.scheduledAt, props.shell.timeZone)}</p>
              <a class="text-action" href={`/items/${item.id}/review`}>
                Reschedule
              </a>
            </>
          ) : (
            <>
              <span class="status">{statusLabel(item.status)}</span>
              {item.scheduledAt ? (
                <time datetime={new Date(item.scheduledAt).toISOString()}>
                  {formatEt(item.scheduledAt, props.shell.timeZone)}
                </time>
              ) : null}
            </>
          )}
          <DeleteControl shell={props.shell} item={item} back="queue" />
        </li>
      ))}
    </ul>
  );
}

function ItemList(props: { items: ItemRecord[]; shell: Shell }) {
  return (
    <ul class="rows">
      {props.items.map((item) => (
        <li>
          <a
            class="text-action"
            href={
              item.status === "draft" ||
              (item.status === "needs_you" && item.needsReason === "rejected")
                ? `/items/${item.id}`
                : `/items/${item.id}/review`
            }
          >
            {firstLine(item)}
          </a>
          <span class="status">{statusLabel(item.status)}</span>
          {item.scheduledAt ? (
            <time datetime={new Date(item.scheduledAt).toISOString()}>
              {formatEt(item.scheduledAt, props.shell.timeZone)}
            </time>
          ) : null}
          <DeleteControl shell={props.shell} item={item} back="queue" />
        </li>
      ))}
    </ul>
  );
}
