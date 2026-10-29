import type { ReviewStage, Status } from "./state";

export const FILTERS = [
  "needs_you",
  "all",
  "draft",
  "needs_hemingway",
  "needs_approval",
  "approved",
  "scheduled",
  "posted",
] as const;
export type Filter = (typeof FILTERS)[number];
export type Bucket =
  | "needs_you"
  | "draft"
  | "needs_hemingway"
  | "needs_approval"
  | "approved"
  | "scheduled"
  | "posted"
  | "archived";

export function parseFilter(value: string | undefined): Filter {
  return (FILTERS as readonly string[]).includes(value ?? "")
    ? (value as Filter)
    : "all";
}

export function bucketOf(
  status: Status,
  stage: ReviewStage,
  missed = false,
): Bucket {
  if (missed && (status === "scheduled" || status === "posting"))
    return "needs_you";
  switch (status) {
    case "draft":
      return stage;
    case "approved":
      return "approved";
    case "scheduled":
    case "posting":
      return "scheduled";
    case "posted":
      return "posted";
    case "needs_you":
      return "needs_you";
    case "archived":
      return "archived";
    default: {
      const neverStatus: never = status;
      return neverStatus;
    }
  }
}

export function filterLabel(filter: Filter): string {
  switch (filter) {
    case "all":
      return "All";
    case "needs_you":
      return "Needs you";
    case "draft":
      return "Draft";
    case "needs_hemingway":
      return "In review";
    case "needs_approval":
      return "Needs your approval";
    case "approved":
      return "Approved";
    case "scheduled":
      return "Scheduled";
    case "posted":
      return "Posted";
    default: {
      const neverFilter: never = filter;
      return neverFilter;
    }
  }
}

const ORDER: Bucket[] = [
  "needs_you",
  "needs_approval",
  "needs_hemingway",
  "draft",
  "approved",
  "scheduled",
  "posted",
  "archived",
];

export function bucketRank(bucket: Bucket): number {
  return ORDER.indexOf(bucket);
}

export function matchesFilter(filter: Filter, bucket: Bucket): boolean {
  if (bucket === "archived") return false;
  if (filter === "all") return true;
  if (filter === "needs_you") return bucket === "needs_you";
  return filter === bucket;
}
