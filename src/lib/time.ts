export const DEFAULT_TIME_ZONE = "America/New_York";

export function isTimeZone(value: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function zoneOf(timeZone?: string): string {
  return timeZone && isTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
}

export type EtParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function partsFrom(utcMs: number, timeZone: string): EtParts {
  const list = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const map: Record<string, string> = {};
  for (const part of list) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
  };
}

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = partsFrom(utcMs, timeZone);
  const secondList = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  let second = 0;
  for (const part of secondList) {
    if (part.type === "second") second = Number(part.value);
  }
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    second,
  );
  return asUtc - utcMs;
}

export function etParts(utcMs: number, timeZone?: string): EtParts {
  return partsFrom(utcMs, zoneOf(timeZone));
}

export function zoneLabel(utcMs: number, timeZone?: string): string {
  const zone = zoneOf(timeZone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    timeZoneName: "short",
  }).formatToParts(new Date(utcMs));
  return parts.find((part) => part.type === "timeZoneName")?.value ?? zone;
}

export function etToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone?: string,
): number | null {
  const zone = zoneOf(timeZone);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let utc = guess - zoneOffsetMs(guess, zone);
  utc = guess - zoneOffsetMs(utc, zone);
  const matches = (candidate: number) => {
    const back = partsFrom(candidate, zone);
    return (
      back.year === year &&
      back.month === month &&
      back.day === day &&
      back.hour === hour &&
      back.minute === minute
    );
  };
  const hits = [utc - 3_600_000, utc, utc + 3_600_000, utc + 7_200_000].filter(
    matches,
  );
  if (hits.length === 0) return null;
  // A fall-back hour happens twice. The later instant never posts early.
  return Math.max(...hits);
}

export function dayKey(utcMs: number, timeZone?: string): string {
  const parts = etParts(utcMs, timeZone);
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${parts.year}-${month}-${day}`;
}

export function formatEt(utcMs: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zoneOf(timeZone),
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(utcMs));
}

export function formatDue(utcMs: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zoneOf(timeZone),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(utcMs));
}

export function formatEtClock(utcMs: number, timeZone?: string): string {
  const zone = zoneOf(timeZone);
  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(utcMs));
  return clock;
}

export function formatUpdated(
  now: number,
  at: number,
  timeZone?: string,
): string {
  const today = etParts(now, timeZone);
  const then = etParts(at, timeZone);
  const same =
    today.year === then.year &&
    today.month === then.month &&
    today.day === then.day;
  if (same) return `today, ${formatEtClock(at, timeZone)}`;
  const start = etToUtc(today.year, today.month, today.day, 0, 0, timeZone);
  const yesterday = start === null ? null : etParts(start - 60_000, timeZone);
  const prior =
    yesterday !== null &&
    yesterday.year === then.year &&
    yesterday.month === then.month &&
    yesterday.day === then.day;
  if (prior) return `yesterday, ${formatEtClock(at, timeZone)}`;
  return formatEt(at, timeZone);
}

export function formatEtDay(utcMs: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zoneOf(timeZone),
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(utcMs));
}

export type EtDay = {
  key: string;
  label: string;
  start: number;
  end: number;
};

export function upcomingEtDays(
  now: number,
  count: number,
  timeZone?: string,
): EtDay[] {
  const days: EtDay[] = [];
  let cursor = etParts(now, timeZone);
  for (let i = 0; i < count; i++) {
    const start = etToUtc(
      cursor.year,
      cursor.month,
      cursor.day,
      0,
      0,
      timeZone,
    );
    const noon = etToUtc(
      cursor.year,
      cursor.month,
      cursor.day,
      12,
      0,
      timeZone,
    );
    if (start === null || noon === null) break;
    const next = etParts(noon + 24 * 60 * 60 * 1000, timeZone);
    const end = etToUtc(next.year, next.month, next.day, 0, 0, timeZone);
    if (end === null) break;
    days.push({
      key: `${cursor.year}-${String(cursor.month).padStart(2, "0")}-${String(cursor.day).padStart(2, "0")}`,
      label: formatEtDay(start, timeZone),
      start,
      end,
    });
    cursor = next;
  }
  return days;
}

export function etDayBounds(
  now: number,
  timeZone?: string,
): { start: number; end: number } | null {
  const parts = etParts(now, timeZone);
  const start = etToUtc(parts.year, parts.month, parts.day, 0, 0, timeZone);
  const noon = etToUtc(parts.year, parts.month, parts.day, 12, 0, timeZone);
  if (start === null || noon === null) return null;
  const next = etParts(noon + 24 * 60 * 60 * 1000, timeZone);
  const end = etToUtc(next.year, next.month, next.day, 0, 0, timeZone);
  if (end === null) return null;
  return { start, end };
}
