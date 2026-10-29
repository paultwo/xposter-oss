import { etParts, etToUtc, formatDue } from "../src/lib/time";

const ZONE = "America/New_York";

// A local time inside the queue's seven-day window, still in the future.
export function upcomingSlot(
  daysAhead = 2,
  hour = 15,
  minute = 0,
): { date: string; time: string; utc: number; dueLabel: string } {
  const parts = etParts(Date.now() + daysAhead * 24 * 60 * 60 * 1000, ZONE);
  const utc = etToUtc(parts.year, parts.month, parts.day, hour, minute, ZONE);
  if (utc === null || utc <= Date.now()) {
    throw new Error("The schedule slot is not in the future.");
  }
  return {
    date: `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    utc,
    dueLabel: formatDue(utc, ZONE),
  };
}
