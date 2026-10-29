import { describe, expect, it } from "vitest";
import { approvalBlocker } from "../../src/items/approval";
import {
  bucketOf,
  FILTERS,
  matchesFilter,
  parseFilter,
} from "../../src/lib/dashboard";
import {
  INTAKE_STAGES,
  isIntakeStage,
  REVIEW_STAGES,
  STATUSES,
} from "../../src/lib/state";

describe("dashboard buckets", () => {
  it("uses the review stage only while the status is draft", () => {
    for (const status of STATUSES) {
      for (const stage of REVIEW_STAGES) {
        const bucket = bucketOf(status, stage);
        if (status === "draft") expect(bucket).toBe(stage);
        else expect(REVIEW_STAGES as readonly string[]).not.toContain(bucket);
      }
    }
    expect(bucketOf("posting", "needs_approval")).toBe("scheduled");
    expect(bucketOf("needs_you", "draft")).toBe("needs_you");
    expect(bucketOf("needs_you", "needs_approval")).toBe("needs_you");
    expect(bucketOf("scheduled", "draft", true)).toBe("needs_you");
    expect(bucketOf("scheduled", "draft", false)).toBe("scheduled");
    expect(FILTERS[0]).toBe("needs_you");
  });

  it("never shows archived items and falls back to all for unknown filters", () => {
    for (const filter of FILTERS)
      expect(matchesFilter(filter, "archived")).toBe(false);
    expect(parseFilter("approved")).toBe("approved");
    expect(parseFilter("posting")).toBe("all");
    expect(parseFilter(undefined)).toBe("all");
  });

  it("allows intake to set only the two editorial stages", () => {
    expect([...INTAKE_STAGES]).toEqual(["needs_hemingway", "needs_approval"]);
    for (const value of ["draft", "approved", "scheduled", "posted", 1, null])
      expect(isIntakeStage(value)).toBe(false);
  });

  it("explains why a long post cannot be approved", () => {
    const limits = { standard: 280, premium: 25000, showMoreAt: 280 };
    const long = { kind: "post" as const, title: null, segments: [] };
    expect(approvalBlocker(long, "none", limits)).toBeNull();
    const over = {
      ...long,
      segments: [
        {
          id: "s",
          position: 0,
          text: "a".repeat(281),
          xPostId: null,
          postedAt: null,
          media: [],
        },
      ],
    };
    expect(approvalBlocker(over, "none", limits)).toBe(
      "Over by 1. Split it into a thread or make it an Article.",
    );
    expect(approvalBlocker(over, "premium", limits)).toBeNull();
    expect(approvalBlocker(over, "basic", limits)).toBeNull();
    const atCap = {
      ...long,
      segments: [{ ...over.segments[0], text: "a".repeat(25000) }],
    };
    const pastCap = {
      ...long,
      segments: [{ ...over.segments[0], text: "a".repeat(25001) }],
    };
    expect(approvalBlocker(atCap, "premium", limits)).toBeNull();
    expect(approvalBlocker(pastCap, "premium", limits)).toBe(
      "A segment is over 25,000 characters.",
    );
    expect(approvalBlocker(pastCap, "none", limits)).toMatch(/Over by/);
    expect(
      approvalBlocker(
        { kind: "article", title: null, segments: [] },
        "none",
        limits,
      ),
    ).toMatch(/title/);
  });
});
