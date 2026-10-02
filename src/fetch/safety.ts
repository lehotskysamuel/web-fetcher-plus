import { BlockList, isIP } from "node:net";
import { FetchError } from "./errors.js";

export const DEFAULT_BLOCKED_DOMAINS = [
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "tiktok.com",
];

// Everything that isn't publicly routable. IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) match the IPv4 rules.
const blockList = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockList.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48],
  ["100::", 64], // discard
  ["2001::", 23], // IETF protocol assignments, incl. Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local
  ["ff00::", 8], // multicast
] as const) {
  blockList.addSubnet(net, prefix, "ipv6");
}

export function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockList.check(address, "ipv4");
  // Only global unicast (2000::/3) is public; ::ffff:0:0/96 is checked against the IPv4 rules by BlockList.
  if (family === 6) {
    if (blockList.check(address, "ipv6")) return false;
    const first = parseInt(address.split(":")[0] || "0", 16);
    return (
      (first & 0xe000) === 0x2000 || address.toLowerCase().startsWith("::ffff:")
    );
  }
  return false;
}

/** The URL's host without IPv6 brackets or a trailing dot, lowercased. */
export function hostOf(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

/**
 * Syntax, scheme, local hosts and the domain blocklist, before any paid request. Not a network defence: Bright Data
 * fetches from its own network, so local and private hosts are refused only because they can't work.
 */
export function checkUrl(input: string, blockedDomains: string[]): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new FetchError(
      "INVALID_URL",
      "Not an absolute URL. Pass a full http(s) URL from the user or a previous tool result.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchError(
      "INVALID_URL",
      `Scheme ${url.protocol} is not supported. Only http and https URLs can be fetched.`,
    );
  }
  if (url.username || url.password) {
    throw new FetchError(
      "INVALID_URL",
      "URLs with credentials are not supported. Remove the user:password part.",
    );
  }

  const host = hostOf(url);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal")
  ) {
    throw new FetchError(
      "URL_NOT_ALLOWED",
      `${host} is a local or internal host. Only public web pages can be fetched.`,
    );
  }
  // The WHATWG parser already normalizes decimal, octal and hex IPv4 forms to dotted quads.
  if (isIP(host) && !isPublicIp(host)) {
    throw new FetchError(
      "URL_NOT_ALLOWED",
      `${host} is a private or reserved address. Only public web pages can be fetched.`,
    );
  }

  const domain = blockedDomains.find(
    (d) => host === d || host.endsWith(`.${d}`),
  );
  if (domain) {
    throw new FetchError(
      "URL_NOT_ALLOWED",
      `${domain} is on this server's blocklist. Tell the user this site can't be fetched with this tool.`,
    );
  }

  return url;
}
