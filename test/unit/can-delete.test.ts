import { describe, expect, it } from "vitest";
import { canDelete } from "../../src/items/delete";
import type { ItemRecord } from "../../src/items/model";

type Deletable = Parameters<typeof canDelete>[0];

function item(overrides: Partial<Deletable> = {}): Deletable {
  return {
    status: "draft",
    postedAt: null,
    xArticleId: null,
    leaseId: null,
    segments: [
      { xPostId: null, postedAt: null },
    ] as unknown as ItemRecord["segments"],
    ...overrides,
  };
}

describe("canDelete", () => {
  it("allows drafts, approved, scheduled, needs-you, and archived items", () => {
    for (const status of [
      "draft",
      "approved",
      "scheduled",
      "needs_you",
      "archived",
    ] as const) {
      expect(canDelete(item({ status })), status).toBe(true);
    }
  });

  it("refuses posting and posted items", () => {
    expect(canDelete(item({ status: "posting" }))).toBe(false);
    expect(canDelete(item({ status: "posted" }))).toBe(false);
  });

  it("refuses a needs-you item that holds a lease or has any part on X", () => {
    expect(canDelete(item({ status: "needs_you", leaseId: "lease" }))).toBe(
      false,
    );
    expect(canDelete(item({ status: "needs_you", postedAt: 1 }))).toBe(false);
    expect(canDelete(item({ status: "needs_you", xArticleId: "art" }))).toBe(
      false,
    );
    expect(
      canDelete(
        item({
          status: "needs_you",
          segments: [
            { xPostId: "1", postedAt: 1 },
            { xPostId: null, postedAt: null },
          ] as unknown as ItemRecord["segments"],
        }),
      ),
    ).toBe(false);
  });
});
