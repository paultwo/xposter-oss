import { afterEach, describe, expect, it, vi } from "vitest";
import { SCOPE_STRING } from "../../src/lib/scopes";
import {
  exchangeCode,
  refreshAccessToken,
  revokeToken,
} from "../../src/x/client";

const CLIENT_ID = "client/id+plus";
const CLIENT_SECRET = "se cret+/=";

function testEnv(): Env {
  return {
    X_API_BASE: "https://api.x.com",
    X_CLIENT_ID: CLIENT_ID,
    X_CLIENT_SECRET: CLIENT_SECRET,
    X_FETCH_TIMEOUT_MS: "1000",
  } as Env;
}

function rawBasic(): string {
  return `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`;
}

function installFetch(): Array<{ authorization: string | null; body: string }> {
  const calls: Array<{ authorization: string | null; body: string }> = [];
  vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      authorization: headers.get("authorization"),
      body: String(init?.body ?? ""),
    });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 7200,
          scope: SCOPE_STRING,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("confidential client token requests", () => {
  it("base64-encodes the raw client id and secret for HTTP Basic", async () => {
    const calls = installFetch();
    const exchanged = await exchangeCode(
      testEnv(),
      "auth-code",
      "verifier",
      "https://poster.example.com/oauth/x/callback",
    );
    expect(exchanged.type).toBe("ok");
    expect(calls[0]?.authorization).toBe(rawBasic());
    expect(calls[0]?.authorization).not.toBe(
      `Basic ${btoa(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(CLIENT_SECRET)}`)}`,
    );
    const body = new URLSearchParams(calls[0]?.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("redirect_uri")).toBe(
      "https://poster.example.com/oauth/x/callback",
    );
    expect(body.get("code_verifier")).toBe("verifier");

    const refreshed = await refreshAccessToken(testEnv(), "refresh");
    expect(refreshed.type).toBe("ok");
    expect(calls[1]?.authorization).toBe(rawBasic());

    await revokeToken(testEnv(), "refresh");
    expect(calls[2]?.authorization).toBe(rawBasic());
    expect(new URLSearchParams(calls[2]?.body).get("token")).toBe("refresh");
  });
});
