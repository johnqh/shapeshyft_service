import { describe, it, expect } from "vitest";
import {
  collectForwardingHeaders,
  isIpv6,
  normalizeClientIp,
  isRoutableClientIp,
  resolveAllowlistIp,
  resolveCallerIp,
} from "../../src/lib/client-ip.js";

describe("normalizeClientIp", () => {
  it("unwraps an IPv4-mapped IPv6 address, which is how Bun reports IPv4", () => {
    expect(normalizeClientIp("::ffff:142.254.88.21")).toBe("142.254.88.21");
    expect(normalizeClientIp("::FFFF:127.0.0.1")).toBe("127.0.0.1");
  });

  it("leaves a plain IPv4 address alone", () => {
    expect(normalizeClientIp("142.254.88.21")).toBe("142.254.88.21");
  });

  it("leaves a real IPv6 address alone", () => {
    expect(normalizeClientIp("2001:db8::1")).toBe("2001:db8::1");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace", "   "],
    ["not an address", "potato"],
  ])("returns null for %s", (_label, value) => {
    expect(normalizeClientIp(value)).toBeNull();
  });
});

describe("isRoutableClientIp", () => {
  it("accepts a public address", () => {
    expect(isRoutableClientIp("142.254.88.21")).toBe(true);
    expect(isRoutableClientIp("2001:db8::1")).toBe(true);
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["loopback high", "127.255.255.254"],
    ["private 10/8", "10.0.0.5"],
    ["private 172.16/12 low", "172.16.0.1"],
    ["private 172.16/12 high", "172.31.255.254"],
    ["private 192.168/16", "192.168.1.5"],
    ["link-local", "169.254.169.254"],
    ["unspecified", "0.0.0.0"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unique-local", "fc00::1"],
    ["IPv6 link-local", "fe80::1"],
  ])("rejects %s", (_label, ip) => {
    expect(isRoutableClientIp(ip)).toBe(false);
  });

  it("does not reject addresses merely adjacent to private ranges", () => {
    expect(isRoutableClientIp("172.15.0.1")).toBe(true);
    expect(isRoutableClientIp("172.32.0.1")).toBe(true);
    expect(isRoutableClientIp("11.0.0.1")).toBe(true);
    expect(isRoutableClientIp("192.169.0.1")).toBe(true);
  });
});

describe("resolveCallerIp", () => {
  const headers = (h: Record<string, string>) => (name: string) =>
    h[name.toLowerCase()];
  const none = () => undefined;

  describe("direct connection from the internet", () => {
    it("uses the peer address", () => {
      expect(resolveCallerIp("142.254.88.21", none)).toBe("142.254.88.21");
    });

    it("ignores a forged X-Forwarded-For, because the peer is not a proxy", () => {
      const result = resolveCallerIp(
        "142.254.88.21",
        headers({ "x-forwarded-for": "169.254.169.254" })
      );
      expect(result).toBe("142.254.88.21");
    });

    it("ignores a forged CF-Connecting-IP from a direct client", () => {
      // No Cloudflare in the path, so the header is whatever the client typed.
      const result = resolveCallerIp(
        "142.254.88.21",
        headers({ "cf-connecting-ip": "169.254.169.254" })
      );
      expect(result).toBe("142.254.88.21");
    });

    it("ignores a forged X-Real-Ip too", () => {
      const result = resolveCallerIp(
        "142.254.88.21",
        headers({ "x-real-ip": "10.0.0.1" })
      );
      expect(result).toBe("142.254.88.21");
    });

    it("unwraps an IPv6-mapped peer", () => {
      expect(resolveCallerIp("::ffff:142.254.88.21", none)).toBe(
        "142.254.88.21"
      );
    });
  });

  describe("behind a trusted proxy, which is what a private peer means", () => {
    it("reads the client from X-Forwarded-For", () => {
      const result = resolveCallerIp(
        "172.18.0.2",
        headers({ "x-forwarded-for": "142.254.88.197" })
      );
      expect(result).toBe("142.254.88.197");
    });

    it("takes the rightmost public entry, not the client-controlled leftmost", () => {
      // A client that sends its own header gets it preserved on the left when a
      // proxy appends; only what the proxy appended can be trusted.
      const result = resolveCallerIp(
        "172.18.0.2",
        headers({ "x-forwarded-for": "169.254.169.254, 142.254.88.197" })
      );
      expect(result).toBe("142.254.88.197");
    });

    it("skips further internal hops when walking right to left", () => {
      const result = resolveCallerIp(
        "172.18.0.2",
        headers({ "x-forwarded-for": "1.2.3.4, 142.254.88.197, 172.18.0.5" })
      );
      expect(result).toBe("142.254.88.197");
    });

    it("prefers CF-Connecting-IP, the only header Cloudflare guarantees is the client", () => {
      // Reproduces the real api.shapeshyft.ai chain: Cloudflare in front of
      // Traefik. Traefik has no trustedIPs, so it discards Cloudflare's
      // X-Forwarded-For and replaces it with the edge address.
      const result = resolveCallerIp(
        "172.18.0.2",
        headers({
          "x-forwarded-for": "104.22.14.180",
          "x-real-ip": "104.22.14.180",
          "cf-connecting-ip": "142.254.88.197",
        })
      );
      expect(result).toBe("142.254.88.197");
    });

    it("falls back to True-Client-IP", () => {
      const result = resolveCallerIp(
        "172.18.0.2",
        headers({
          "x-forwarded-for": "104.22.14.180",
          "true-client-ip": "142.254.88.197",
        })
      );
      expect(result).toBe("142.254.88.197");
    });

    it("ignores an unusable CF-Connecting-IP and falls through", () => {
      const result = resolveCallerIp(
        "172.18.0.2",
        headers({
          "cf-connecting-ip": "not-an-ip",
          "x-forwarded-for": "142.254.88.197",
        })
      );
      expect(result).toBe("142.254.88.197");
    });

    it("ignores a private CF-Connecting-IP and falls through", () => {
      const result = resolveCallerIp(
        "172.18.0.2",
        headers({
          "cf-connecting-ip": "10.0.0.1",
          "x-forwarded-for": "142.254.88.197",
        })
      );
      expect(result).toBe("142.254.88.197");
    });

    it("falls back to X-Real-Ip when there is no X-Forwarded-For", () => {
      const result = resolveCallerIp(
        "172.18.0.2",
        headers({ "x-real-ip": "142.254.88.197" })
      );
      expect(result).toBe("142.254.88.197");
    });

    it("prefers X-Forwarded-For over X-Real-Ip", () => {
      const result = resolveCallerIp(
        "172.18.0.2",
        headers({
          "x-forwarded-for": "142.254.88.197",
          "x-real-ip": "9.9.9.9",
        })
      );
      expect(result).toBe("142.254.88.197");
    });

    it("returns null when the proxy forwarded nothing usable", () => {
      expect(resolveCallerIp("172.18.0.2", none)).toBeNull();
      expect(
        resolveCallerIp("172.18.0.2", headers({ "x-forwarded-for": "garbage" }))
      ).toBeNull();
    });

    it("returns null when every forwarded entry is itself internal", () => {
      const result = resolveCallerIp(
        "172.18.0.2",
        headers({ "x-forwarded-for": "10.0.0.1, 172.18.0.5" })
      );
      expect(result).toBeNull();
    });

    it("treats loopback as a trusted hop, for a proxy on the same host", () => {
      const result = resolveCallerIp(
        "127.0.0.1",
        headers({ "x-forwarded-for": "142.254.88.197" })
      );
      expect(result).toBe("142.254.88.197");
    });

    it("tolerates the spacing proxies actually emit", () => {
      const result = resolveCallerIp(
        "172.18.0.2",
        headers({ "x-forwarded-for": "  142.254.88.197  " })
      );
      expect(result).toBe("142.254.88.197");
    });
  });

  it("returns null when there is no peer address at all", () => {
    expect(resolveCallerIp(null, none)).toBeNull();
    expect(resolveCallerIp(undefined, none)).toBeNull();
  });
});

describe("collectForwardingHeaders", () => {
  const from = (h: Record<string, string>) => (name: string) =>
    h[name.toLowerCase()];

  it("collects the headers that carry a client address", () => {
    const result = collectForwardingHeaders(
      from({
        "x-forwarded-for": "1.2.3.4",
        "cf-connecting-ip": "5.6.7.8",
        "x-real-ip": "9.9.9.9",
      })
    );

    expect(result).toEqual({
      "x-forwarded-for": "1.2.3.4",
      "cf-connecting-ip": "5.6.7.8",
      "x-real-ip": "9.9.9.9",
    });
  });

  it("omits headers that are absent rather than reporting them empty", () => {
    expect(collectForwardingHeaders(from({ "x-real-ip": "9.9.9.9" }))).toEqual({
      "x-real-ip": "9.9.9.9",
    });
  });

  it("returns an empty object when nothing was forwarded", () => {
    expect(collectForwardingHeaders(from({}))).toEqual({});
  });

  it.each([
    ["x-api-key", "shyftent_supersecret"],
    ["authorization", "Bearer eyJhbGciOi"],
    ["cookie", "session=abc"],
    ["x-forwarded-authorization", "Bearer leak"],
  ])("never echoes back the credential header %s", (name, value) => {
    const result = collectForwardingHeaders(from({ [name]: value }));
    expect(JSON.stringify(result)).not.toContain(value);
    expect(result[name]).toBeUndefined();
  });

  it("includes Cloudflare's client header, which survives a proxy that rewrites XFF", () => {
    const result = collectForwardingHeaders(
      from({ "cf-connecting-ip": "142.254.88.197", "cf-ray": "abc-CDG" })
    );
    expect(result["cf-connecting-ip"]).toBe("142.254.88.197");
    expect(result["cf-ray"]).toBe("abc-CDG");
  });
});

describe("isIpv6", () => {
  it.each([
    ["full form", "2001:0db8:85a3:0000:0000:8a2e:0370:7334"],
    ["compressed", "2001:db8::1"],
    ["loopback", "::1"],
    ["unspecified", "::"],
    ["leading compression", "::ffff:1.2.3.4"],
    ["trailing compression", "2001:db8::"],
    ["eight groups", "1:2:3:4:5:6:7:8"],
    ["embedded IPv4", "1:2:3:4:5:6:1.2.3.4"],
    ["unique local", "fc00::1"],
  ])("accepts %s", (_label, value) => {
    expect(isIpv6(value)).toBe(true);
  });

  it.each([
    ["a bare colon", ":"],
    ["a trailing colon", "a:"],
    ["a leading colon", ":a"],
    ["too few groups", "1:2"],
    ["too many groups", "1:2:3:4:5:6:7:8:9"],
    ["a group over four digits", "12345::1"],
    ["a non-hex group", "gggg::1"],
    ["two compressions", "1::2::3"],
    ["triple colon", ":::"],
    ["quadruple colon", "::::"],
    ["a zone index, unusable in a URL", "fe80::1%eth0"],
    ["an empty string", ""],
    ["no colon at all", "1.2.3.4"],
    ["an embedded IPv4 that is invalid", "::ffff:999.1.1.1"],
    ["an embedded IPv4 not in last position", "1:1.2.3.4:2"],
    ["compressed but overlong", "1:2:3:4:5:6:7::8"],
  ])("rejects %s", (_label, value) => {
    expect(isIpv6(value)).toBe(false);
  });

  it("never reports a malformed value as a routable client address", () => {
    for (const junk of [":", "a:", "1:2", ":::", "gggg::1"]) {
      expect(normalizeClientIp(junk)).toBeNull();
    }
  });
});

describe("resolveAllowlistIp", () => {
  const headers = (h: Record<string, string>) => (name: string) =>
    h[name.toLowerCase()];
  const none = () => undefined;

  it("uses a public peer and ignores a forged X-Forwarded-For", () => {
    // The bypass this exists to close: a direct caller naming an allowed IP.
    expect(
      resolveAllowlistIp(
        "142.254.88.21",
        headers({ "x-forwarded-for": "1.2.3.4" })
      )
    ).toBe("142.254.88.21");
  });

  it("reads the client a trusted proxy forwarded", () => {
    expect(
      resolveAllowlistIp(
        "172.18.0.2",
        headers({ "x-forwarded-for": "6.6.6.6, 142.254.88.21" })
      )
    ).toBe("142.254.88.21");
  });

  it("ignores a spoofed leftmost X-Forwarded-For entry behind a proxy", () => {
    // The proxy appends the real client; the leftmost entry came from the caller.
    expect(
      resolveAllowlistIp(
        "172.18.0.2",
        headers({ "x-forwarded-for": "1.2.3.4, 142.254.88.21" })
      )
    ).not.toBe("1.2.3.4");
  });

  it("falls back to a private peer that forwarded no client", () => {
    // A caller on the private network itself: the peer cannot be forged.
    expect(resolveAllowlistIp("10.0.0.7", none)).toBe("10.0.0.7");
  });

  it("does not let a header name a private address behind a proxy", () => {
    expect(
      resolveAllowlistIp(
        "172.18.0.2",
        headers({ "x-forwarded-for": "10.0.0.7" })
      )
    ).toBe("172.18.0.2");
  });

  it("returns null when the peer is unknown, whatever the headers say", () => {
    expect(
      resolveAllowlistIp(null, headers({ "x-forwarded-for": "1.2.3.4" }))
    ).toBeNull();
  });
});
