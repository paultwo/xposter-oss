const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const WILDCARD_SUFFIXES = [".nip.io", ".sslip.io", ".xip.io", ".localtest.me"];

export function isBlockedHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  ) {
    return true;
  }
  if (WILDCARD_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    const embedded = ipEmbeddedInName(host);
    return embedded === null || isBlockedIp(embedded);
  }
  return isBlockedIp(host);
}

function ipEmbeddedInName(host: string): string | null {
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(host);
  if (dotted?.[1] && isDottedQuad(dotted[1])) return dotted[1];
  const dashed = /(\d{1,3}(?:-\d{1,3}){3})/.exec(host);
  if (dashed?.[1]) {
    const quad = dashed[1].replaceAll("-", ".");
    if (isDottedQuad(quad)) return quad;
  }
  return null;
}

function isDottedQuad(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    return n <= 255;
  });
}

export function isBlockedIp(value: string): boolean {
  const host = value.toLowerCase();
  if (host.includes(".")) {
    if (host.startsWith("::ffff:"))
      return isBlockedIp(host.slice("::ffff:".length));
    return isBlockedV4(host);
  }
  return isBlockedV6(host);
}

function isBlockedV4(host: string): boolean {
  if (!isDottedQuad(host)) return false;
  const [a, b] = host.split(".").map((part) => Number(part));
  if (a === undefined || b === undefined) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedV6(host: string): boolean {
  if (host === "::" || host === "::1") return true;
  if (host.startsWith("fc") || host.startsWith("fd")) return true;
  if (
    host.startsWith("fe80") ||
    host.startsWith("fe8") ||
    host.startsWith("fe9") ||
    host.startsWith("fea") ||
    host.startsWith("feb")
  ) {
    return true;
  }
  if (host === "fd00:ec2::254") return true;
  if (host.startsWith("2001:db8")) return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (mapped?.[1]) return isBlockedV4(mapped[1]);
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (hexMapped?.[1] && hexMapped[2]) {
    const hi = Number.parseInt(hexMapped[1], 16);
    const lo = Number.parseInt(hexMapped[2], 16);
    const quad = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
    return isBlockedV4(quad);
  }
  return false;
}

export async function readLimitedStream(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error("too_large");
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("too_large");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    total += step.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("too_large");
    }
    chunks.push(step.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export const IMAGE_BYTE_CAP = MAX_IMAGE_BYTES;
