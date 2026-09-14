/**
 * @fileoverview Client IP resolution
 * @description Who is really calling, given the connection's peer address and
 * its forwarded headers. Used by the endpoint IP allowlist, and by products
 * that point self-hosted providers at the caller (ShapeShyft's provider sync).
 *
 * Kept free of Hono and the database so the address parsing -- which is where
 * the sharp edges are -- can be tested directly. The peer address itself comes
 * from the runtime (`getConnInfo` from `hono/bun`), which the app supplies as
 * `getPeerAddress`.
 */

/** IPv4 dotted quad, each octet 0-255. */
const IPV4_RE =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** A single IPv6 group: one to four hex digits. */
const IPV6_GROUP_RE = /^[0-9a-f]{1,4}$/i;

/** Is this an IPv4 literal? */
export function isIpv4(value: string): boolean {
  return IPV4_RE.test(value);
}

/**
 * Count the groups on one side of a `::`, or null if the side is malformed.
 *
 * An embedded IPv4 tail (`::ffff:1.2.3.4`) is only legal as the final group and
 * occupies two of the eight, which is why this returns a count rather than a
 * boolean.
 */
function countIpv6Groups(side: string): number | null {
  if (side === "") return 0;

  const groups = side.split(":");
  let count = 0;

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    if (group === "") return null; // a stray colon, e.g. "a:" or ":a"

    if (group.includes(".")) {
      // A dotted quad is only an address here in the final position.
      if (i !== groups.length - 1 || !isIpv4(group)) return null;
      count += 2;
      continue;
    }

    if (!IPV6_GROUP_RE.test(group)) return null;
    count += 1;
  }

  return count;
}

/**
 * Is this an IPv6 literal?
 *
 * Parsed rather than pattern-matched. The regex this replaced accepted `":"`,
 * `"a:"`, and `"1:2"` as valid, which meant a malformed forwarded header could
 * be treated as a routable client address and written into a provider URL.
 *
 * A zone index (`fe80::1%eth0`) is rejected: it is a valid address but cannot be
 * used as a URL host, which is the only thing this library does with one.
 */
export function isIpv6(value: string): boolean {
  if (!value.includes(":") || value.includes("%")) return false;

  const sides = value.split("::");
  if (sides.length > 2) return false; // "::" may appear at most once

  const head = countIpv6Groups(sides[0]!);
  if (head === null) return false;

  // Uncompressed: all eight groups must be spelled out.
  if (sides.length === 1) return head === 8;

  const tail = countIpv6Groups(sides[1]!);
  if (tail === null) return false;

  // "::" must stand in for at least one omitted group.
  return head + tail <= 7;
}

/** Is this any IP literal, as opposed to a DNS hostname? */
export function isIpLiteral(value: string): boolean {
  return isIpv4(value) || isIpv6(value);
}

/**
 * Normalize a peer address reported by the server.
 *
 * Bun reports an IPv4 peer as an IPv4-mapped IPv6 address
 * (`::ffff:142.254.88.21`), which is the same address wearing a hat. Unwrap it
 * so what gets written into a provider URL is the address a person would type.
 *
 * @param raw - The address from `getConnInfo(c).remote.address`
 * @returns A bare IP literal, or null when there is nothing usable
 */
export function normalizeClientIp(
  raw: string | undefined | null
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const mapped = /^::ffff:(.+)$/i.exec(trimmed);
  const candidate = mapped?.[1] ?? trimmed;

  return isIpLiteral(candidate) ? candidate : null;
}

/**
 * Is this an address worth writing into a provider URL?
 *
 * A loopback, private, or link-local peer means the request did not come from
 * the internet -- a local test, a sidecar, or a proxy on the same host. Writing
 * one of those would quietly break every endpoint using the provider, so the
 * sync refuses rather than "succeeding" with an address that resolves nowhere
 * useful from the API's perspective.
 */
export function isRoutableClientIp(ip: string): boolean {
  if (isIpv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    if (a === 0 || a === 127) return false; // unspecified, loopback
    if (a === 10) return false; // 10/8
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16/12
    if (a === 192 && b === 168) return false; // 192.168/16
    if (a === 169 && b === 254) return false; // 169.254/16 link-local
    return true;
  }

  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return false; // unspecified, loopback
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return false; // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return false; // fe80::/10 link-local
  return true;
}

/**
 * Headers that may carry a client address, and are safe to echo back.
 *
 * An explicit allowlist, never "every header": the request also carries the
 * caller's `X-API-Key`, and a diagnostic that reflected the whole header set
 * back would hand a credential to anything reading the response or the logs.
 */
export const FORWARDING_HEADERS = [
  "x-forwarded-for",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "x-client-ip",
  "x-cluster-client-ip",
  "fastly-client-ip",
  "x-original-forwarded-for",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "cf-ray",
  "cf-ipcountry",
  "via",
] as const;

/**
 * Gather the forwarding-related headers actually present on a request.
 *
 * For diagnosing what a deployment's proxies really send, which is the only
 * reliable way to know which header holds the client address -- guessing it
 * from an infrastructure repo is how a Cloudflare edge IP ends up written into
 * a provider URL.
 *
 * @param getHeader - Case-insensitive header lookup
 * @returns Only the allowlisted headers that are present
 */
export function collectForwardingHeaders(
  getHeader: (name: string) => string | undefined
): Record<string, string> {
  const found: Record<string, string> = {};
  for (const name of FORWARDING_HEADERS) {
    const value = getHeader(name);
    if (value !== undefined && value !== "") {
      found[name] = value;
    }
  }
  return found;
}

/**
 * Resolve who is really calling, given the connection's peer and its headers.
 *
 * A forwarded header is written by whoever is upstream, so it is only worth
 * anything once we know the hop that sent it is our own infrastructure. The
 * peer address settles that: an attacker on the internet cannot make their TCP
 * connection appear to originate from a private address.
 *
 * - **Public peer** -- the client reached us directly. Use the peer and ignore
 *   every header, forged or not.
 * - **Private or loopback peer** -- we are behind our own reverse proxy
 *   (Traefik on the Docker network, in this deployment). Read the client from
 *   the forwarded headers it set.
 *
 * On the trusted branch the headers are consulted in a deliberate order:
 *
 * 1. `CF-Connecting-IP` / `True-Client-IP` -- a CDN's own client header, which
 *    it overwrites on every request and a client therefore cannot forge.
 * 2. `X-Forwarded-For`, read **right to left**, taking the first public entry.
 *    Each proxy appends the address that connected to it, so the right-hand
 *    entries were written by trusted infrastructure while the leftmost may have
 *    come from the client.
 * 3. `X-Real-Ip`.
 *
 * The CDN header must come first, and this is not theoretical. On
 * api.shapeshyft.ai the chain is Cloudflare -> Traefik -> API, and Traefik has
 * no `forwardedHeaders.trustedIPs`, so it *discards* Cloudflare's
 * `X-Forwarded-For` and rewrites it with the Cloudflare edge address. That edge
 * address is public, so every "is this routable" check passes and it looks like
 * a perfectly good client IP -- it just is not one, and it changes from request
 * to request. `CF-Connecting-IP` is the only header in that chain carrying the
 * real client.
 *
 * @param peerAddress - The connection's peer, from `getConnInfo(c).remote.address`
 * @param getHeader - Case-insensitive header lookup
 * @returns The caller's IP, or null when it cannot be established
 */
export function resolveCallerIp(
  peerAddress: string | null | undefined,
  getHeader: (name: string) => string | undefined
): string | null {
  const peer = normalizeClientIp(peerAddress);
  if (!peer) return null;

  // A public peer is the client itself. Headers add nothing and can only lie.
  if (isRoutableClientIp(peer)) {
    return peer;
  }

  // Private peer: a hop inside our own network, so its headers are worth reading.

  // A CDN's client header first: it is overwritten upstream on every request,
  // whereas X-Forwarded-For may have been rewritten by an intermediate proxy
  // that does not trust the CDN.
  for (const name of ["cf-connecting-ip", "true-client-ip"]) {
    const cdnClient = normalizeClientIp(getHeader(name));
    if (cdnClient && isRoutableClientIp(cdnClient)) {
      return cdnClient;
    }
  }

  const forwardedFor = getHeader("x-forwarded-for");
  if (forwardedFor) {
    const hops = forwardedFor.split(",");
    for (let i = hops.length - 1; i >= 0; i--) {
      const candidate = normalizeClientIp(hops[i]!.trim());
      if (candidate && isRoutableClientIp(candidate)) {
        return candidate;
      }
    }
  }

  const realIp = normalizeClientIp(getHeader("x-real-ip"));
  if (realIp && isRoutableClientIp(realIp)) {
    return realIp;
  }

  return null;
}

/** Outcome of rewriting one provider URL. */
export type UrlRewrite =
  | { status: "updated"; url: string }
  | { status: "unchanged" }
  | { status: "skipped"; reason: string };

/**
 * The address an endpoint's IP allowlist is checked against.
 *
 * `resolveCallerIp`, falling back to the peer itself. The fallback covers a
 * caller on the private network that reached us without a proxy: its peer
 * address is private, so `resolveCallerIp` looks for forwarded headers and finds
 * none -- but the peer is a TCP fact and cannot be forged, so it is the answer.
 *
 * What this replaced trusted the leftmost `X-Forwarded-For` entry from anyone,
 * which let a caller holding a project key claim any allowlisted address.
 *
 * @param peerAddress - The connection's peer; null when the runtime cannot say
 * @param getHeader - Case-insensitive header lookup
 * @returns The caller's IP, or null when it cannot be established (deny)
 */
export function resolveAllowlistIp(
  peerAddress: string | null | undefined,
  getHeader: (name: string) => string | undefined
): string | null {
  return (
    resolveCallerIp(peerAddress, getHeader) ?? normalizeClientIp(peerAddress)
  );
}
