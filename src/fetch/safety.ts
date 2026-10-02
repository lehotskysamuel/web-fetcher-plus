import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
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
const blocked = new BlockList();
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
  blocked.addSubnet(net, prefix, "ipv4");
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
  blocked.addSubnet(net, prefix, "ipv6");
}

export function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  // Only global unicast (2000::/3) is public; ::ffff:0:0/96 is checked against the IPv4 rules by BlockList.
  if (family === 6) {
    if (blocked.check(address, "ipv6")) return false;
    const first = parseInt(address.split(":")[0] || "0", 16);
    return (first & 0xe000) === 0x2000 || address.toLowerCase().startsWith("::ffff:");
  }
  return false;
}

/** The URL's host without IPv6 brackets or a trailing dot, lowercased. */
export function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

/** Syntax, scheme, domain blocklist and query guard. No network access. */
export function checkUrl(input: string, blockedDomains: string[], { checkQuery = true } = {}): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new FetchError("INVALID_URL", "Not an absolute URL. Pass a full http(s) URL from the user or a previous tool result.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchError("INVALID_URL", `Scheme ${url.protocol} is not supported. Only http and https URLs can be fetched.`);
  }
  if (url.username || url.password) {
    throw new FetchError("INVALID_URL", "URLs with credentials are not supported. Remove the user:password part.");
  }

  const host = hostOf(url);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new FetchError("SSRF_BLOCKED", `${host} is a local or internal host. Only public web pages can be fetched.`);
  }
  // The WHATWG parser already normalizes decimal, octal and hex IPv4 forms to dotted quads.
  if (isIP(host) && !isPublicIp(host)) {
    throw new FetchError("SSRF_BLOCKED", `${host} is a private or reserved address. Only public web pages can be fetched.`);
  }

  const domain = blockedDomains.find((d) => host === d || host.endsWith(`.${d}`));
  if (domain) {
    throw new FetchError("DOMAIN_BLOCKED", `${domain} is on this server's blocklist. Tell the user this site can't be fetched with this tool.`);
  }

  if (checkQuery) {
    for (const [key, value] of url.searchParams) {
      const reason = suspiciousValue(value) ?? suspiciousValue(key);
      if (reason) {
        throw new FetchError(
          "SUSPICIOUS_QUERY",
          `The query string contains ${reason}. Fetch the URL exactly as the user gave it, or ask the user for the page.`,
        );
      }
    }
  }
  return url;
}

/** Why a query value looks like smuggled data, or undefined if it looks harmless. */
export function suspiciousValue(value: string): string | undefined {
  if (value.length > 64) return "a value longer than 64 characters";
  if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(value)) return "an email address";
  if (/^eyJ[\w-]+\.[\w-]+/.test(value)) return "a token";
  if (/^(sk|pk|rk)[-_]|^(ghp|gho|ghs|github_pat|xox[abprs]|glpat)[-_]|^AKIA[0-9A-Z]{12}/.test(value)) return "a token";
  if (/^[0-9a-f]{16,}$/i.test(value) && /[a-f]/i.test(value) && /\d/.test(value)) return "a hex blob";
  if (/^[A-Za-z0-9+/_-]{20,}={0,2}$/.test(value) && /\d/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value)) {
    return "a base64 blob";
  }
  return undefined;
}

/** Resolves the host and refuses it unless every address is public. */
export async function checkHostResolves(url: URL): Promise<void> {
  const host = hostOf(url);
  if (isIP(host)) return; // checked in checkUrl
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new FetchError("HTTP_ERROR", `Could not resolve ${host}. Check the URL for typos.`);
  }
  const bad = addresses.find((a) => !isPublicIp(a.address));
  if (bad) {
    throw new FetchError("SSRF_BLOCKED", `${host} resolves to a private or reserved address. Only public web pages can be fetched.`);
  }
}
