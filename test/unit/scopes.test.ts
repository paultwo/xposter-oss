import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SCOPE_ALLOWLIST,
  SCOPE_STRING,
  scopesAreExact,
} from "../../src/lib/scopes";

const EXACT = "tweet.read tweet.write users.read media.write offline.access";

describe("scopes", () => {
  it("requests the allowlist and nothing else", () => {
    expect(SCOPE_ALLOWLIST).toEqual([
      "tweet.read",
      "tweet.write",
      "users.read",
      "media.write",
      "offline.access",
    ]);
    expect(SCOPE_STRING).toBe(EXACT);
  });

  it("accepts the same scopes in any order and rejects anything else", () => {
    expect(scopesAreExact(EXACT)).toBe(true);
    expect(
      scopesAreExact(
        "offline.access media.write users.read tweet.write tweet.read",
      ),
    ).toBe(true);
    expect(scopesAreExact(`${EXACT} dm.read`)).toBe(false);
    expect(
      scopesAreExact("tweet.read tweet.write users.read media.write"),
    ).toBe(false);
    expect(scopesAreExact(`${EXACT} tweet.read`)).toBe(false);
    expect(scopesAreExact("")).toBe(false);
    expect(scopesAreExact(undefined)).toBe(false);
  });
});

describe("banned strings", () => {
  it("keeps blocked scope and endpoint names out of src", () => {
    const banned = [
      "dm.",
      "/2/dm",
      "/2/chat",
      "public_keys",
      "dm_image",
      "dm_video",
      "dm_gif",
      "oauth1",
    ];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        const text = readFileSync(path, "utf8");
        for (const needle of banned) {
          if (text.includes(needle)) hits.push(`${path}: ${needle}`);
        }
      }
    };
    walk("src");
    expect(hits).toEqual([]);
  });
});
