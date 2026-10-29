import type { ItemRecord } from "../items/model";
import { formatDue, formatEtClock } from "../lib/time";
import { X_TIMEOUT_DETAIL } from "../x/client";

export function initials(
  displayName: string | null,
  username: string | null,
): string {
  const source = (displayName ?? username ?? "").trim();
  if (!source) return "";
  const parts = source.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? "") : "";
  const letters = last
    ? `${first.slice(0, 1)}${last.slice(0, 1)}`
    : first.slice(0, 1);
  return letters.toUpperCase();
}

export function firstLine(
  item: Pick<ItemRecord, "segments" | "title">,
): string {
  const text = item.segments[0]?.text ?? item.title ?? "";
  const line = text.split("\n").find((entry) => entry.trim()) ?? "Empty draft";
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

export function missedCopy(scheduledAt: number, timeZone: string): string {
  return `Missed: was due ${formatDue(scheduledAt, timeZone)}. Missed posts never go out late. Reschedule to post it.`;
}

export function timeoutMoment(at: number, timeZone: string): string {
  return `X timed out at ${formatEtClock(at, timeZone)}`;
}

export function unknownCopy(
  item: { lastError: string | null; updatedAt: number },
  timeZone: string,
): string {
  if (item.lastError === X_TIMEOUT_DETAIL) {
    return `${timeoutMoment(item.updatedAt, timeZone)}. Check X to see whether it posted before you send it again.`;
  }
  return "We don't know if this post went out. Check X before you send it again.";
}

export function pauseConfirmCopy(): string {
  return "A post that's already sending may still go out. Nothing else will post after that. Only whoever runs this app can turn posting back on.";
}

export function postingLabel(shell: {
  postingEnabled: boolean;
  postingPaused: boolean;
  timeZoneLabel: string;
}): string {
  if (shell.postingEnabled) {
    return `Posting is on. Scheduled posts go out at their time (${shell.timeZoneLabel}).`;
  }
  if (shell.postingPaused) {
    return "Posting is paused. Nothing will go out. Only whoever runs this app can turn posting back on.";
  }
  return "Posting is off. Nothing will post, even scheduled items.";
}

export function postingClass(shell: {
  postingEnabled: boolean;
  postingPaused: boolean;
}): string {
  if (shell.postingEnabled) return "pill pill-on";
  if (shell.postingPaused) return "pill pill-paused";
  return "pill pill-off";
}
