import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { markdownToContentState } from "../../src/lib/article";
import { costLine, estimateCost, formatDollars } from "../../src/lib/cost";
import {
  nextStatus,
  STATUSES,
  type Status,
  type Transition,
} from "../../src/lib/state";
import {
  foldAt,
  overLimitCopy,
  splitWeighted,
  weightedLength,
} from "../../src/lib/text";
import { etToUtc, formatDue } from "../../src/lib/time";
import { missedCopy } from "../../src/ui/text";

function actionKey(action: Transition): string {
  if (action.type === "edit") return `edit:${action.hashChanged}`;
  return action.type;
}

function expected(from: Status, action: Transition): Status | null {
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

const actions: Transition[] = [
  { type: "approve" },
  { type: "schedule" },
  { type: "unschedule" },
  { type: "edit", hashChanged: false },
  { type: "edit", hashChanged: true },
  { type: "archive" },
  { type: "restore" },
  { type: "claim" },
  { type: "posted" },
  { type: "continue" },
  { type: "needs_you" },
  { type: "rate_limited" },
  { type: "resume" },
  { type: "mark_posted" },
];

describe("state machine", () => {
  it("covers every status and every action", () => {
    expect(STATUSES).toHaveLength(7);
    for (const from of STATUSES) {
      for (const action of actions) {
        expect(nextStatus(from, action), `${from} ${actionKey(action)}`).toBe(
          expected(from, action),
        );
      }
    }
  });
});

describe("weighted length", () => {
  it("counts urls, emoji, and cjk the way X does", () => {
    expect(weightedLength("hello")).toBe(5);
    expect(weightedLength("https://example.com/path")).toBe(23);
    expect(weightedLength("see https://example.com now")).toBe(4 + 23 + 4);
    expect(weightedLength("😀")).toBe(2);
    expect(weightedLength("你")).toBe(2);
    expect(weightedLength("a".repeat(280))).toBe(280);
    expect(weightedLength("a".repeat(281))).toBe(281);
    const folded = foldAt("a".repeat(281), 280);
    expect(folded.head).toBe("a".repeat(280));
    expect(folded.rest).toBe("a");
    expect(foldAt("a".repeat(280), 280).rest).toBe("");
  });

  it("splits on weighted boundaries", () => {
    const parts = splitWeighted(`${"word ".repeat(80)}end`, 280);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts)
      expect(weightedLength(part)).toBeLessThanOrEqual(280);
    expect(parts.join(" ")).toContain("end");
    const overflow = Array.from({ length: 26 }, () => "a".repeat(280)).join(
      " ",
    );
    expect(() => splitWeighted(overflow, 280)).toThrow(/25 posts/);
  });
});

describe("eastern time", () => {
  it("converts noon across the November 2026 and March 2027 changes", () => {
    expect(new Date(etToUtc(2026, 10, 31, 12, 0) ?? 0).toISOString()).toBe(
      "2026-10-31T16:00:00.000Z",
    );
    expect(new Date(etToUtc(2026, 11, 1, 12, 0) ?? 0).toISOString()).toBe(
      "2026-11-01T17:00:00.000Z",
    );
    expect(new Date(etToUtc(2027, 3, 13, 12, 0) ?? 0).toISOString()).toBe(
      "2027-03-13T17:00:00.000Z",
    );
    expect(new Date(etToUtc(2027, 3, 14, 12, 0) ?? 0).toISOString()).toBe(
      "2027-03-14T16:00:00.000Z",
    );
  });

  it("rejects the skipped hour and returns one instant for the repeated hour", () => {
    expect(etToUtc(2027, 3, 14, 2, 30)).toBeNull();
    const first = etToUtc(2026, 11, 1, 1, 30);
    const second = etToUtc(2026, 11, 1, 1, 30);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    const iso = new Date(first ?? 0).toISOString();
    expect(iso).toBe("2026-11-01T06:30:00.000Z");
    expect(formatDue(Date.parse("2026-10-20T13:00:00.000Z"))).toBe(
      "Oct 20, 9:00 AM EDT",
    );
    expect(
      missedCopy(Date.parse("2026-10-23T13:00:00.000Z"), "America/New_York"),
    ).toBe(
      "Missed: was due Oct 23, 9:00 AM EDT. Missed posts never go out late. Reschedule to post it.",
    );
  });
});

describe("cost and articles", () => {
  it("prices a plain post, a link, and alt text", () => {
    const estimate = estimateCost("thread", [
      { text: "Hello", altCount: 0, hasMedia: false },
      { text: "See https://example.com", altCount: 1, hasMedia: true },
    ]);
    expect(estimate.thousandths).toBe(15 + 200 + 5);
    expect(formatDollars(estimate.thousandths)).toBe("$0.220");
    expect(estimate.mediaNote).toBe(true);
    expect(costLine(estimate)).toBe(
      "X API cost: about $0.22 (image upload not included).",
    );
    expect(
      costLine(
        estimateCost("thread", [
          { text: "One", altCount: 0, hasMedia: false },
          { text: "Two", altCount: 1, hasMedia: true },
        ]),
      ),
    ).toBe("X API cost: about $0.04 (image upload not included).");
    expect(overLimitCopy(280 + 4582, 280)).toBe(
      "Over by 4,582. Split it into a thread or make it an Article.",
    );
    expect(
      estimateCost("article", [{ text: "Body", altCount: 0, hasMedia: false }])
        .articleNote,
    ).toBe(true);
  });

  it("turns a small markdown subset into content state", () => {
    const state = markdownToContentState(
      "# Title\n\n- **Bold** item\nSee [docs](https://example.com)",
    );
    expect(state.blocks[0]?.type).toBe("header-one");
    expect(
      state.blocks.some((block) => block.type === "unordered-list-item"),
    ).toBe(true);
    expect(
      state.blocks.some((block) =>
        block.inlineStyleRanges.some((style) => style.style === "BOLD"),
      ),
    ).toBe(true);
    expect(
      Object.values(state.entityMap).some(
        (entity) => entity.data.url === "https://example.com",
      ),
    ).toBe(true);
  });
});

describe("wrangler config", () => {
  it("ships posting off, workers.dev off, and names secrets without values", () => {
    const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8")) as {
      account_id?: string;
      workers_dev: boolean;
      preview_urls: boolean;
      compatibility_date: string;
      routes?: unknown;
      triggers: { crons: string[] };
      d1_databases: Array<{ database_name: string; database_id: string }>;
      vars: Record<string, string>;
    };
    expect(config.account_id).toBeUndefined();
    expect(config.routes).toBeUndefined();
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.triggers.crons).toEqual(["* * * * *"]);
    expect(config.vars.POSTING_ENABLED).toBe("false");
    expect(config.vars.X_STANDARD_POST_LIMIT).toBe("280");
    expect(config.vars.X_PREMIUM_POST_LIMIT).toBe("25000");
    expect(config.vars.X_SHOW_MORE_AT).toBe("280");
    expect(config.vars.X_USERNAME).toBeUndefined();
    expect(config.vars.LONG_POSTS).toBeUndefined();
    expect(config.vars.ENVIRONMENT).toBe("production");
    expect(config.d1_databases[0]?.database_name).toBe("x-poster");
    expect(config.d1_databases[0]?.database_id).toBe(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(config.vars.ACCESS_AUD).toBe("YOUR_ACCESS_AUD");
    expect(config.vars.ACCESS_CERTS_URL).toBe("");
    expect(config.vars.PUBLIC_ORIGIN).toBe("https://poster.example.com");
    expect(config.compatibility_date).toBe("2025-12-10");
    expect(config.vars.ACCESS_TEAM_DOMAIN).toBe("team.example.invalid");
    expect(config.vars.ALLOWED_APPROVER_EMAILS).toBe("you@example.com");
    expect("secrets" in config).toBe(false);
    const local = JSON.parse(
      readFileSync("wrangler.local.jsonc.example", "utf8"),
    ) as {
      account_id: string;
      routes: Array<{ pattern: string; custom_domain: boolean }>;
      d1_databases: Array<{ database_id: string }>;
      vars: Record<string, string>;
      workers_dev: boolean;
    };
    expect(local.account_id).toBe("YOUR_CLOUDFLARE_ACCOUNT_ID");
    expect(local.routes[0]?.pattern).toBe("poster.example.com");
    expect(local.routes[0]?.custom_domain).toBe(true);
    expect(local.d1_databases[0]?.database_id).toBe("YOUR_D1_DATABASE_ID");
    expect(local.vars.ACCESS_AUD).toBe("YOUR_ACCESS_AUD");
    expect(local.vars.ACCESS_TEAM_DOMAIN).toBe("team.example.invalid");
    expect(local.vars.ALLOWED_APPROVER_EMAILS).toBe("you@example.com");
    expect(local.vars.PUBLIC_ORIGIN).toBe("https://poster.example.com");
    expect(local.vars.POSTING_ENABLED).toBe("false");
    expect(local.workers_dev).toBe(false);
    const example = readFileSync(".dev.vars.example", "utf8");
    for (const name of [
      "X_CLIENT_ID",
      "X_CLIENT_SECRET",
      "TOKEN_ENC_KEY",
      "CSRF_SECRET",
      "INTAKE_TOKEN",
    ])
      expect(example).toContain(`${name}=`);
    expect(example).not.toMatch(/=.+/);
  });

  it("keeps the proof config on the zero database id and test-audience", () => {
    const proof = JSON.parse(readFileSync("wrangler.proof.jsonc", "utf8")) as {
      d1_databases: Array<{ database_id: string }>;
      vars: Record<string, string>;
    };
    expect(proof.d1_databases[0]?.database_id).toBe(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(proof.vars.ACCESS_AUD).toBe("test-audience");
    const allow = proof.vars.ALLOWED_APPROVER_EMAILS.split(",");
    expect(allow).toEqual(["you@example.com"]);
    for (const email of allow)
      expect(email.endsWith("@example.com")).toBe(true);
  });

  it("matches the example config except the per-deployment keys", () => {
    const committed = JSON.parse(readFileSync("wrangler.jsonc", "utf8")) as {
      name: string;
      build: { command: string };
      d1_databases: Array<Record<string, string>>;
    };
    const example = JSON.parse(
      readFileSync("wrangler.local.jsonc.example", "utf8"),
    ) as {
      name: string;
      build: { command: string };
      d1_databases: Array<Record<string, string>>;
    };
    expect(committed.name).toBe("x-poster-unconfigured");
    expect(example.name).toBe("x-poster");
    expect(committed.build.command).toBe(
      "node scripts/refuse-committed-deploy.mjs",
    );
    expect(example.build.command).toBe(
      "node scripts/preflight-deploy.mjs --config wrangler.local.jsonc",
    );
    expect(comparable(committed)).toEqual(comparable(example));
  });
});

function comparable(config: {
  name?: string;
  account_id?: string;
  routes?: unknown;
  build?: unknown;
  d1_databases: Array<Record<string, string>>;
}): {
  name?: string;
  account_id?: string;
  routes?: unknown;
  build?: unknown;
  d1_databases: Array<Record<string, string>>;
} {
  const copy = structuredClone(config);
  delete copy.name;
  delete copy.account_id;
  delete copy.routes;
  delete copy.build;
  delete copy.d1_databases[0]?.database_id;
  return copy;
}
