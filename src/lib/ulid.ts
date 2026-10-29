const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now = Date.now()): string {
  let time = "";
  let stamp = now;
  for (let i = 0; i < 10; i++) {
    time = ENCODING[stamp & 31] + time;
    stamp = Math.floor(stamp / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let buffer = 0;
  let bits = 0;
  let random = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      random += ENCODING[(buffer >> bits) & 31];
    }
  }
  return time + random;
}

export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}
