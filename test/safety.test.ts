import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchError } from "../src/fetch/errors.js";
import { checkHostResolves, checkUrl, DEFAULT_BLOCKED_DOMAINS, isPublicIp, suspiciousValue } from "../src/fetch/safety.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => {
    const table: Record<string, string[]> = {
      "rebind.example": ["93.184.215.14", "127.0.0.1"],
      "public.example": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
      "v6private.example": ["fd00::1"],
    };
    if (!table[host]) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return table[host].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  }),
}));

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as FetchError).code;
  }
  return "OK";
};
const check = (url: string) => code(() => checkUrl(url, DEFAULT_BLOCKED_DOMAINS));

afterEach(() => vi.clearAllMocks());

describe("SSRF", () => {
  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://2852039166/", // decimal 169.254.169.254
    "http://0251.0376.0251.0376/", // octal
    "http://0xA9FEA9FE/", // hex
    "http://127.1/",
    "http://0.0.0.0/",
    "http://10.0.0.1/",
    "http://172.16.5.4/",
    "http://192.168.1.1/",
    "http://100.64.0.1/",
    "http://[::1]/",
    "http://[::]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[fc00::1]/",
    "http://[fd12:3456::1]/",
    "http://[fe80::1]/",
    "http://localhost/",
    "http://LOCALHOST./",
    "http://app.localhost/",
    "http://metadata.google.internal/",
  ])("blocks %s", (url) => {
    expect(check(url)).toBe("SSRF_BLOCKED");
  });

  it("allows public addresses", () => {
    expect(check("http://93.184.215.14/")).toBe("OK");
    expect(check("http://[2606:4700::6810:84e5]/")).toBe("OK");
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("::ffff:8.8.8.8")).toBe(true);
  });

  it("refuses hosts that resolve to any private address", async () => {
    await expect(checkHostResolves(new URL("https://rebind.example/"))).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
    await expect(checkHostResolves(new URL("https://v6private.example/"))).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
    await expect(checkHostResolves(new URL("https://public.example/"))).resolves.toBeUndefined();
  });

  it("rejects non-http schemes and junk", () => {
    expect(check("ftp://example.com/")).toBe("INVALID_URL");
    expect(check("file:///etc/passwd")).toBe("INVALID_URL");
    expect(check("javascript:alert(1)")).toBe("INVALID_URL");
    expect(check("example.com")).toBe("INVALID_URL");
    expect(check("https://user:pw@example.com/")).toBe("INVALID_URL");
  });

  it("blocks configured domains and their subdomains", () => {
    expect(check("https://www.facebook.com/page")).toBe("DOMAIN_BLOCKED");
    expect(check("https://x.com/")).toBe("DOMAIN_BLOCKED");
    expect(check("https://linkedin.com./in/someone")).toBe("DOMAIN_BLOCKED");
    expect(check("https://notx.com/")).toBe("OK");
  });
});

describe("query guard", () => {
  it.each([
    ["long value", "a".repeat(65)],
    ["email", "jane.doe@example.com"],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"],
    ["API key", "sk-proj-abc123"],
    ["GitHub token", "ghp_abcdefABCDEF123456"],
    ["hex blob", "deadbeef00112233aabb"],
    ["base64 blob", "U2VjcmV0IGRhdGEgaGVyZQ1"],
  ])("refuses a %s", (_, value) => {
    expect(suspiciousValue(value)).toBeDefined();
    expect(check(`https://example.com/?v=${encodeURIComponent(value)}`)).toBe("SUSPICIOUS_QUERY");
  });

  it.each(["hello world", "2", "en-US", "utm_source", "1234567890123456789", "sourdough-bread-recipe", "Q3_2026_report"])(
    "allows %s",
    (value) => {
      expect(suspiciousValue(value)).toBeUndefined();
    },
  );

  it("checks keys too", () => {
    expect(check(`https://example.com/?${"k".repeat(70)}=1`)).toBe("SUSPICIOUS_QUERY");
  });

  it("can be skipped for server-issued redirects", () => {
    expect(code(() => checkUrl(`https://example.com/?t=${"a".repeat(80)}`, [], { checkQuery: false }))).toBe("OK");
  });
});
