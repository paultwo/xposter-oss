import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function allowedEmails(env: Env): string[] {
  const raw =
    typeof env.ALLOWED_APPROVER_EMAILS === "string"
      ? env.ALLOWED_APPROVER_EMAILS
      : "";
  return raw
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
}

export function certsUrl(env: Env): string {
  if (env.ACCESS_CERTS_URL) return env.ACCESS_CERTS_URL;
  return `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
}

export function allowedAudiences(env: Env): string[] {
  const raw = typeof env.ACCESS_AUD === "string" ? env.ACCESS_AUD : "";
  return raw
    .split(",")
    .map((audience) => audience.trim())
    .filter((audience) => audience.length > 0);
}

export async function verifyAccessJwt(
  env: Env,
  token: string,
): Promise<JWTPayload> {
  const audience = allowedAudiences(env);
  if (audience.length === 0) throw new Error("access_unconfigured");
  const url = certsUrl(env);
  let jwks = jwksCache.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, jwks);
  }
  const { payload } = await jwtVerify(token, jwks, {
    issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
    audience,
  });
  return payload;
}

export function devEmail(request: Request, env: Env): string | null {
  if (env.ENVIRONMENT !== "development") return null;
  const host = new URL(request.url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") return null;
  const email =
    request.headers.get("x-dev-access-email")?.trim().toLowerCase() ?? "";
  if (!email || !allowedEmails(env).includes(email)) return null;
  return email;
}
