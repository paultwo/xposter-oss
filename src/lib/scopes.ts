export const SCOPE_ALLOWLIST = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "media.write",
  "offline.access",
] as const;

export const SCOPE_STRING = SCOPE_ALLOWLIST.join(" ");

const ALLOWED = new Set<string>(SCOPE_ALLOWLIST);

export function scopesAreExact(granted: string | undefined): boolean {
  if (!granted) return false;
  const parts = granted.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length !== SCOPE_ALLOWLIST.length) return false;
  const seen = new Set(parts);
  if (seen.size !== parts.length) return false;
  for (const scope of seen) {
    if (!ALLOWED.has(scope)) return false;
  }
  return true;
}
