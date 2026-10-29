import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  asUser,
  auth,
  cookieHeader,
  ORIGIN,
  type Session,
  send,
} from "./helpers";
import { resetX, xstate } from "./mock-x";

beforeEach(() => {
  resetX();
});

describe("oauth callback", () => {
  async function start(
    session: Session,
  ): Promise<{ state: string; cookie: string }> {
    const response = await SELF.fetch(`${ORIGIN}/oauth/x/start`, {
      headers: auth(session),
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(
      "https://x.com/i/oauth2/authorize",
    );
    expect(location.searchParams.get("scope")).toBe(
      "tweet.read tweet.write users.read media.write offline.access",
    );
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://poster.example.com/oauth/x/callback",
    );
    return {
      state: location.searchParams.get("state") ?? "",
      cookie: cookieHeader(response, session.cookie),
    };
  }

  async function callback(
    session: Session,
    cookie: string,
    state: string,
  ): Promise<string> {
    const response = await SELF.fetch(
      `${ORIGIN}/oauth/x/callback?code=abc&state=${encodeURIComponent(state)}`,
      {
        headers: { ...auth(session), cookie },
        redirect: "manual",
      },
    );
    const cleared = response.headers.getSetCookie?.() ?? [];
    expect(
      cleared.some((row) => row.startsWith("xp_oauth=") && /secure/i.test(row)),
    ).toBe(true);
    return response.headers.get("location") ?? "";
  }

  it("rejects a bad state and an extra scope, and stores the connected account", async () => {
    const session = await asUser();
    const bad = await start(session);
    expect(await callback(session, bad.cookie, "not-the-state")).toContain(
      "error=state",
    );

    const extra = await start(session);
    xstate.tokenScopes =
      "tweet.read tweet.write users.read media.write offline.access dm.read";
    expect(await callback(session, extra.cookie, extra.state)).toContain(
      "error=scope",
    );

    const other = await start(session);
    xstate.tokenScopes =
      "tweet.read tweet.write users.read media.write offline.access";
    xstate.username = "someoneelse";
    xstate.displayName = "Someone Else";
    xstate.subscriptionType = "Premium";
    expect(await callback(session, other.cookie, other.state)).toContain(
      "notice=connected",
    );

    const row = await env.DB.prepare(
      "SELECT x_username, display_name, subscription_type FROM oauth_account WHERE id = 1",
    ).first<{
      x_username: string;
      display_name: string;
      subscription_type: string;
    }>();
    expect(row?.x_username).toBe("someoneelse");
    expect(row?.display_name).toBe("Someone Else");
    expect(row?.subscription_type).toBe("Premium");
  });

  it("revokes the new refresh token when users/me fails", async () => {
    const session = await asUser();
    const pending = await start(session);
    xstate.meStatus = 500;
    expect(await callback(session, pending.cookie, pending.state)).toContain(
      "error=oauth",
    );
    expect(xstate.paths).toContain("/2/oauth2/revoke");
    const row = await env.DB.prepare(
      "SELECT id FROM oauth_account WHERE id = 1",
    ).first();
    expect(row).toBeNull();
  });

  it("stores the connected account and does not return the token", async () => {
    const session = await asUser();
    const otherHost = await SELF.fetch("https://evil.example/oauth/x/start", {
      headers: auth(session),
      redirect: "manual",
    });
    const otherLocation = new URL(otherHost.headers.get("location") ?? "");
    expect(otherLocation.searchParams.get("redirect_uri")).toBe(
      "https://poster.example.com/oauth/x/callback",
    );
    const pending = await start(session);
    expect(await callback(session, pending.cookie, pending.state)).toContain(
      "notice=connected",
    );
    const account = await send(session, "/api/account", "GET");
    const text = await account.text();
    expect(text).not.toContain("refreshed-access-token");
    expect(text).not.toContain("refreshed-refresh-token");
    expect(text).toContain("exampleuser");
  });
});
