import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppEnv, FormMap } from "../http/types";
import { AppError } from "../items/model";
import { timingSafeEqualText } from "../lib/crypto";
import { allowedEmails, devEmail, verifyAccessJwt } from "./access";
import { consumeQuota, resolveBearer } from "./intake";
import { newSession, openSession, sealSession } from "./session";

const STATIC_EXACT = new Set(["/app.css", "/app.js"]);

function isStatic(path: string): boolean {
  if (path.includes("..")) return false;
  return STATIC_EXACT.has(path) || path.startsWith("/fonts/");
}

function cookieOptions(url: string): {
  httpOnly: true;
  sameSite: "Strict";
  secure: boolean;
  path: "/";
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "Strict",
    secure: new URL(url).protocol === "https:",
    path: "/",
    maxAge: 60 * 60 * 24,
  };
}

export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  c.header(
    "content-security-policy",
    "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
  c.header("x-frame-options", "DENY");
  c.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
  if (
    !c.req.path.startsWith("/fonts/") &&
    c.req.path !== "/app.css" &&
    c.req.path !== "/app.js"
  ) {
    c.header("cache-control", "no-store");
  }
});

export const authenticate = createMiddleware<AppEnv>(async (c, next) => {
  const host = new URL(c.req.url).hostname;
  if (
    c.req.path === "/api/health" &&
    c.req.method === "GET" &&
    c.env.ENVIRONMENT === "development" &&
    (host === "127.0.0.1" || host === "localhost")
  ) {
    return c.json({ ok: true });
  }

  const jwt = c.req.header("cf-access-jwt-assertion");
  try {
    const allow = allowedEmails(c.env);
    if (jwt) {
      const payload = await verifyAccessJwt(c.env, jwt);
      const email =
        typeof payload.email === "string" ? payload.email.toLowerCase() : "";
      const commonName =
        typeof payload.common_name === "string" ? payload.common_name : "";
      const intakeClientId =
        typeof c.env.INTAKE_ACCESS_CLIENT_ID === "string"
          ? c.env.INTAKE_ACCESS_CLIENT_ID
          : "";
      if (c.req.path.startsWith("/api/intake")) {
        if (!intakeClientId || commonName !== intakeClientId) {
          return c.text("Forbidden", 403);
        }
        const header = c.req.header("authorization") ?? "";
        const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
        const token = await resolveBearer(c.env, presented, Date.now());
        if (!token) return c.text("Forbidden", 403);
        await consumeQuota(c.env, token.id, Date.now());
        c.set("identity", {
          kind: "service",
          tokenId: token.id,
          name: token.name,
        });
        c.set("csrf", "");
        c.set("form", null);
        await next();
        return;
      }
      const serviceOnHealth =
        c.req.path === "/api/health" &&
        intakeClientId.length > 0 &&
        commonName === intakeClientId;
      if (
        c.req.path === "/api/health" &&
        (allow.includes(email) || serviceOnHealth)
      ) {
        c.set(
          "identity",
          allow.includes(email) && email
            ? { kind: "human", email }
            : { kind: "service", tokenId: commonName, name: "health" },
        );
        c.set("csrf", "");
        c.set("form", null);
        await next();
        return;
      }
      if (!allow.includes(email)) return c.text("Forbidden", 403);
      await attachHuman(c, email);
      await next();
      return;
    }
  } catch {
    return c.text("Forbidden", 403);
  }

  const bypass = devEmail(c.req.raw, c.env);
  if (bypass && !c.req.path.startsWith("/api/intake")) {
    await attachHuman(c, bypass);
    await next();
    return;
  }
  return c.text("Forbidden", 403);
});

async function attachHuman(c: Context<AppEnv>, email: string): Promise<void> {
  const current = await openSession(
    c.env.CSRF_SECRET,
    getCookie(c, "xp_session"),
  );
  const session =
    current && current.email === email ? current : newSession(email);
  if (!current || current.email !== email) {
    setCookie(
      c,
      "xp_session",
      await sealSession(c.env.CSRF_SECRET, session),
      cookieOptions(c.req.url),
    );
  }
  c.header("x-csrf-token", session.csrf);
  c.set("identity", { kind: "human", email });
  c.set("csrf", session.csrf);
  c.set("form", null);
}

export const protectCsrf = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.method === "GET" && isStatic(c.req.path)) {
    if (c.get("identity")?.kind !== "human") return c.text("Forbidden", 403);
    const response = await c.env.ASSETS.fetch(c.req.raw);
    const headers = new Headers(response.headers);
    headers.set("cache-control", "public, max-age=3600");
    headers.set("x-content-type-options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  }
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    await next();
    return;
  }
  const identity = c.get("identity");
  if (identity?.kind !== "human") {
    await next();
    return;
  }
  const session = await openSession(
    c.env.CSRF_SECRET,
    getCookie(c, "xp_session"),
  );
  let token = c.req.header("x-csrf-token") ?? "";
  const type = c.req.header("content-type") ?? "";
  if (type.includes("form") || type.includes("multipart")) {
    const parsed = await c.req.parseBody();
    const form: FormMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" || value instanceof File) form[key] = value;
    }
    c.set("form", form);
    if (!token && typeof form.csrf === "string") token = form.csrf;
  }
  if (
    !session ||
    session.email !== identity.email ||
    !timingSafeEqualText(token, session.csrf)
  ) {
    throw new AppError(403, "The form expired. Reload the page and try again.");
  }
  await next();
});
