export const KINDS = ["post", "thread", "article"] as const;
export type Kind = (typeof KINDS)[number];

// Every status has a human action. Unknown and rejected attempts share
// needs_you; the reason says which buttons apply. Missed stays a flag on
// scheduled, and its action is Reschedule.
export const STATUSES = [
  "draft",
  "approved",
  "scheduled",
  "posting",
  "posted",
  "needs_you",
  "archived",
] as const;
export type Status = (typeof STATUSES)[number];

export const NEEDS_REASONS = ["unknown", "rejected"] as const;
export type NeedsReason = (typeof NEEDS_REASONS)[number];

export const REVIEW_STAGES = [
  "draft",
  "needs_hemingway",
  "needs_approval",
] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];
export const INTAKE_STAGES = ["needs_hemingway", "needs_approval"] as const;
export type IntakeStage = (typeof INTAKE_STAGES)[number];

export function isIntakeStage(value: unknown): value is IntakeStage {
  return (
    typeof value === "string" &&
    (INTAKE_STAGES as readonly string[]).includes(value)
  );
}

export function isNeedsReason(value: string | null): value is NeedsReason {
  return value !== null && (NEEDS_REASONS as readonly string[]).includes(value);
}

export type Transition =
  | { type: "approve" }
  | { type: "schedule" }
  | { type: "unschedule" }
  | { type: "edit"; hashChanged: boolean }
  | { type: "archive" }
  | { type: "restore" }
  | { type: "claim" }
  | { type: "posted" }
  | { type: "continue" }
  | { type: "needs_you" }
  | { type: "rate_limited" }
  | { type: "resume" }
  | { type: "mark_posted" };

export function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}

export function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

export function nextStatus(from: Status, action: Transition): Status | null {
  switch (action.type) {
    case "approve":
      return from === "draft" ? "approved" : null;
    case "schedule":
      return from === "approved" ? "scheduled" : null;
    case "unschedule":
      return from === "scheduled" ? "approved" : null;
    case "edit":
      if (from === "posting" || from === "posted" || from === "archived") {
        return null;
      }
      if (!action.hashChanged) return from;
      if (
        from === "draft" ||
        from === "approved" ||
        from === "scheduled" ||
        from === "needs_you"
      ) {
        return "draft";
      }
      return null;
    case "archive":
      if (
        from === "draft" ||
        from === "approved" ||
        from === "scheduled" ||
        from === "needs_you"
      ) {
        return "archived";
      }
      return null;
    case "restore":
      return from === "archived" ? "draft" : null;
    case "claim":
      return from === "scheduled" ? "posting" : null;
    case "posted":
      return from === "posting" ? "posted" : null;
    case "continue":
      return from === "posting" ? "scheduled" : null;
    case "needs_you":
      return from === "posting" ? "needs_you" : null;
    case "rate_limited":
      return from === "posting" ? "scheduled" : null;
    case "resume":
      return from === "needs_you" ? "scheduled" : null;
    case "mark_posted":
      return from === "needs_you" ? "posted" : null;
    default: {
      const neverAction: never = action;
      return neverAction;
    }
  }
}

export function statusLabel(status: Status): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "approved":
      return "Approved";
    case "scheduled":
      return "Scheduled";
    case "posting":
      return "Posting";
    case "posted":
      return "Posted";
    case "needs_you":
      return "Needs you";
    case "archived":
      return "Archived";
    default: {
      const neverStatus: never = status;
      return neverStatus;
    }
  }
}
