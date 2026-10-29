import { describe, expect, it } from "vitest";
import { isBlockedHost, isBlockedIp } from "../../src/lib/ssrf";

describe("blocked image hosts", () => {
  it("blocks private, loopback, link-local, mapped, and metadata names", () => {
    const blocked = [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "localhost",
      "metadata.google.internal",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "127.0.0.1.nip.io",
      "10.0.0.1.sslip.io",
    ];
    for (const host of blocked) {
      expect(isBlockedHost(host) || isBlockedIp(host), host).toBe(true);
    }
    expect(isBlockedHost("pbs.twimg.com")).toBe(false);
    expect(isBlockedIp("8.8.8.8")).toBe(false);
  });
});
