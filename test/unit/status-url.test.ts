import { describe, expect, it } from "vitest";
import { parseStatusUrl } from "../../src/lib/status-url";

const user = "exampleuser";

describe("status link", () => {
  it("reads the id from an x.com or twitter.com status url", () => {
    expect(
      parseStatusUrl("https://x.com/exampleuser/status/424242", user),
    ).toBe("424242");
    expect(
      parseStatusUrl("https://twitter.com/ExampleUser/status/99", user),
    ).toBe("99");
    expect(
      parseStatusUrl("https://www.x.com/exampleuser/status/7?s=20", user),
    ).toBe("7");
    expect(parseStatusUrl("https://x.com/i/web/status/55", user)).toBeNull();
    expect(
      parseStatusUrl("https://mobile.twitter.com/i/status/12", user),
    ).toBeNull();
  });

  it("rejects anything that is not that post's status link", () => {
    expect(
      parseStatusUrl("http://x.com/exampleuser/status/1", user),
    ).toBeNull();
    expect(parseStatusUrl("https://x.com/someone/status/1", user)).toBeNull();
    expect(
      parseStatusUrl("https://example.com/exampleuser/status/1", user),
    ).toBeNull();
    expect(
      parseStatusUrl("https://x.com/exampleuser/status/abc", user),
    ).toBeNull();
    expect(parseStatusUrl("https://x.com/exampleuser", user)).toBeNull();
    expect(
      parseStatusUrl("https://user:pass@x.com/exampleuser/status/1", user),
    ).toBeNull();
    expect(parseStatusUrl("not a url", user)).toBeNull();
  });
});
