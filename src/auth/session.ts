import { base64UrlToUtf8, utf8ToBase64Url } from "../lib/bytes";
import { randomToken, signPayload, timingSafeEqualText } from "../lib/crypto";

export type Session = {
  email: string;
  csrf: string;
  exp: number;
};

export async function sealSession(
  secret: string,
  session: Session,
): Promise<string> {
  const payload = utf8ToBase64Url(JSON.stringify(session));
  const sig = await signPayload(secret, payload);
  return `${payload}.${sig}`;
}

export async function openSession(
  secret: string,
  token: string | undefined,
): Promise<Session | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!payload || !sig) return null;
  const expected = await signPayload(secret, payload);
  if (!timingSafeEqualText(sig, expected)) return null;
  try {
    const session = JSON.parse(base64UrlToUtf8(payload)) as Session;
    if (!session.email || !session.csrf || session.exp < Date.now())
      return null;
    return session;
  } catch {
    return null;
  }
}

export function newSession(email: string): Session {
  return {
    email,
    csrf: randomToken(32),
    exp: Date.now() + 24 * 60 * 60 * 1000,
  };
}

export async function sealOauth(
  secret: string,
  value: { state: string; verifier: string; exp: number },
): Promise<string> {
  const payload = utf8ToBase64Url(JSON.stringify(value));
  const sig = await signPayload(secret, payload);
  return `${payload}.${sig}`;
}

export async function openOauth(
  secret: string,
  token: string | undefined,
): Promise<{ state: string; verifier: string; exp: number } | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!payload || !sig) return null;
  const expected = await signPayload(secret, payload);
  if (!timingSafeEqualText(sig, expected)) return null;
  try {
    const value = JSON.parse(base64UrlToUtf8(payload)) as {
      state: string;
      verifier: string;
      exp: number;
    };
    if (!value.state || !value.verifier || value.exp < Date.now()) return null;
    return value;
  } catch {
    return null;
  }
}
