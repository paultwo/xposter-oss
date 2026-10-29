import { base64ToBytes, bytesToBase64, bytesToBase64Url } from "./bytes";

export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export function timingSafeEqualText(left: string, right: string): boolean {
  return timingSafeEqual(
    new TextEncoder().encode(left),
    new TextEncoder().encode(right),
  );
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function tokenMatches(
  presented: string,
  expectedSha256Hex: string,
): Promise<boolean> {
  const actual = await sha256Hex(presented);
  return timingSafeEqualText(actual, expectedSha256Hex);
}

async function importAesKey(keyBase64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(keyBase64);
  if (raw.length !== 32)
    throw new Error("TOKEN_ENC_KEY must decode to 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptString(
  keyBase64: string,
  plaintext: string,
): Promise<{ cipher: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesKey(keyBase64);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    cipher: bytesToBase64(new Uint8Array(cipher)),
    iv: bytesToBase64(iv),
  };
}

export async function decryptString(
  keyBase64: string,
  cipher: string,
  iv: string,
): Promise<string> {
  const key = await importAesKey(keyBase64);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) },
    key,
    base64ToBytes(cipher),
  );
  return new TextDecoder().decode(plain);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function signPayload(
  secret: string,
  payload: string,
): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return bytesToBase64Url(new Uint8Array(sig));
}

export function randomToken(bytes = 32): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}
