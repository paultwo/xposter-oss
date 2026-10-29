const SENSITIVE_KEY =
  /token|secret|authorization|cookie|password|verifier|code/i;

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE =
  /\b(?:\+?\d{1,3}[\s.-])?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g;

export function scrub(value: string): string {
  return value
    .replace(/bearer\s+\S+/gi, "bearer [redacted]")
    .replace(EMAIL, "[redacted]")
    .replace(PHONE, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
}

export function log(
  level: "info" | "error",
  event: string,
  fields: Record<string, string | number | boolean | null> = {},
): void {
  const safe: Record<string, string | number | boolean | null> = {
    level,
    event,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(key)) continue;
    safe[key] = typeof value === "string" ? scrub(value) : value;
  }
  console.log(JSON.stringify(safe));
}
