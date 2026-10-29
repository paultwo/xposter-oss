import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { openOauth, sealOauth } from "../auth/session";
import { redirectUri } from "../http/shell";
import type { AppEnv } from "../http/types";
import { bytesToBase64Url } from "../lib/bytes";
import { randomToken, timingSafeEqualText } from "../lib/crypto";
import { log } from "../lib/log";
import { SCOPE_STRING } from "../lib/scopes";
import { cacheAvatar, disconnectAccount, saveTokenBundle } from "../x/account";
import { exchangeCode, fetchMe, revokeToken } from "../x/client";

export function registerOauthRoutes(app: Hono<AppEnv>): void {
  app.get("/oauth/x/start", async (c) => {
    const state = randomToken(16);
    const verifier = randomToken(32);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    const challenge = bytesToBase64Url(new Uint8Array(digest));
    const sealed = await sealOauth(c.env.CSRF_SECRET, {
      state,
      verifier,
      exp: Date.now() + 10 * 60 * 1000,
    });
    // X redirects back cross-site. A Strict cookie would not be sent on that
    // top-level navigation, so state could never match.
    setCookie(c, "xp_oauth", sealed, {
      httpOnly: true,
      sameSite: "Lax",
      secure: new URL(c.req.url).protocol === "https:",
      path: "/",
      maxAge: 600,
    });
    const callback = redirectUri(c.env);
    const url = new URL(c.env.X_AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", c.env.X_CLIENT_ID);
    url.searchParams.set("redirect_uri", callback);
    url.searchParams.set("scope", SCOPE_STRING);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return c.redirect(url.toString(), 302);
  });

  app.get("/oauth/x/callback", async (c) => {
    const url = new URL(c.req.url);
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const pending = await openOauth(
      c.env.CSRF_SECRET,
      getCookie(c, "xp_oauth"),
    );
    deleteCookie(c, "xp_oauth", { path: "/", secure: true });
    if (!pending || !timingSafeEqualText(pending.state, state) || !code) {
      return c.redirect("/settings?error=state", 303);
    }
    const callback = redirectUri(c.env);
    const token = await exchangeCode(c.env, code, pending.verifier, callback);
    if (token.type === "rejected" && token.detail === "scope")
      return c.redirect("/settings?error=scope", 303);
    if (token.type !== "ok") return c.redirect("/settings?error=oauth", 303);
    const me = await fetchMe(c.env, token.value.accessToken);
    if (me.type !== "ok") {
      await revokeToken(c.env, token.value.refreshToken);
      return c.redirect("/settings?error=oauth", 303);
    }
    await saveTokenBundle(c.env, token.value, me.value, Date.now());
    await cacheAvatar(c.env, me.value.profileImageUrl);
    log("info", "x_connected", { username: me.value.username });
    return c.redirect("/settings?notice=connected", 303);
  });

  app.post("/oauth/x/disconnect", async (c) => {
    await disconnectAccount(c.env);
    log("info", "x_disconnected", {});
    return c.redirect("/settings?notice=disconnected", 303);
  });
}
