export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodedBase64Length(value: string): number {
  const cleaned = value.replace(/\s/g, "");
  if (cleaned.length === 0) return 0;
  const padding = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
  return Math.floor((cleaned.length * 3) / 4) - padding;
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const pad = (4 - (value.length % 4)) % 4;
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat(pad);
  return base64ToBytes(padded);
}

export function utf8ToBase64Url(value: string): string {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

export function base64UrlToUtf8(value: string): string {
  return new TextDecoder().decode(base64UrlToBytes(value));
}
