const HOSTS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
]);

// Pulls the numeric status id out of an x.com or twitter.com status URL.
// Returns null when the link is anything else.
export function parseStatusUrl(raw: string, username: string): string | null {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!HOSTS.has(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  // /i/status/:id can belong to any account. Only the connected username's
  // /status/:id form is accepted, so a link cannot bind this thread to
  // someone else's post.
  if (
    parts.length !== 3 ||
    parts[1]?.toLowerCase() !== "status" ||
    !parts[0] ||
    !parts[2] ||
    parts[0].toLowerCase() === "i" ||
    parts[0].toLowerCase() !== username.toLowerCase()
  ) {
    return null;
  }
  return /^\d{1,30}$/.test(parts[2]) ? parts[2] : null;
}
