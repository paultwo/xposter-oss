import { describe, expect, it } from "vitest";
import {
  pauseConfirmCopy,
  timeoutMoment,
  unknownCopy,
} from "../../src/ui/text";

describe("timeout moment", () => {
  it("names the clock in the viewer's time zone", () => {
    expect(
      timeoutMoment(Date.parse("2026-10-23T21:07:00.000Z"), "America/New_York"),
    ).toBe("X timed out at 5:07 PM EDT");
  });

  it("names the 2026-11-01 fall-back pair and the 2027-03-14 spring-forward", () => {
    expect(
      timeoutMoment(Date.parse("2026-11-01T05:30:00.000Z"), "America/New_York"),
    ).toBe("X timed out at 1:30 AM EDT");
    expect(
      timeoutMoment(Date.parse("2026-11-01T06:30:00.000Z"), "America/New_York"),
    ).toBe("X timed out at 1:30 AM EST");
    expect(
      timeoutMoment(Date.parse("2027-03-14T07:30:00.000Z"), "America/New_York"),
    ).toBe("X timed out at 3:30 AM EDT");
  });
});

describe("unknown copy", () => {
  it("uses the settled clock only when the call timed out", () => {
    expect(
      unknownCopy(
        {
          lastError: "The request to X timed out.",
          updatedAt: Date.parse("2026-10-23T21:01:05.000Z"),
        },
        "America/New_York",
      ),
    ).toBe(
      "X timed out at 5:01 PM EDT. Check X to see whether it posted before you send it again.",
    );
  });

  it("does not call a 500 a timeout", () => {
    const copy = unknownCopy(
      {
        lastError: "X returned 500.",
        updatedAt: Date.parse("2026-10-23T21:00:50.000Z"),
      },
      "America/New_York",
    );
    expect(copy).toBe(
      "We don't know if this post went out. Check X before you send it again.",
    );
    expect(copy).not.toMatch(/timed out/i);
  });
});

describe("pause confirm copy", () => {
  it("says a post that's already sending may still go out", () => {
    expect(pauseConfirmCopy()).toBe(
      "A post that's already sending may still go out. Nothing else will post after that. Only whoever runs this app can turn posting back on.",
    );
  });
});
