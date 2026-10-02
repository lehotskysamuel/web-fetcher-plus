import { describe, expect, it } from "vitest";
import { FetchError } from "../src/fetch/errors.js";
import {
  checkUrl,
  DEFAULT_BLOCKED_DOMAINS,
  isPublicIp,
} from "../src/fetch/safety.js";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as FetchError).code;
  }
  return "OK";
};
const check = (url: string) =>
  code(() => checkUrl(url, DEFAULT_BLOCKED_DOMAINS));

describe("local and private hosts", () => {
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
    expect(check(url)).toBe("URL_NOT_ALLOWED");
  });

  it("allows public addresses", () => {
    expect(check("http://93.184.215.14/")).toBe("OK");
    expect(check("http://[2606:4700::6810:84e5]/")).toBe("OK");
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("::ffff:8.8.8.8")).toBe(true);
  });

  it("rejects non-http schemes and junk", () => {
    expect(check("ftp://example.com/")).toBe("INVALID_URL");
    expect(check("file:///etc/passwd")).toBe("INVALID_URL");
    expect(check("javascript:alert(1)")).toBe("INVALID_URL");
    expect(check("example.com")).toBe("INVALID_URL");
    expect(check("https://user:pw@example.com/")).toBe("INVALID_URL");
  });

  it("blocks configured domains and their subdomains", () => {
    expect(check("https://www.facebook.com/page")).toBe("URL_NOT_ALLOWED");
    expect(check("https://x.com/")).toBe("URL_NOT_ALLOWED");
    expect(check("https://linkedin.com./in/someone")).toBe("URL_NOT_ALLOWED");
    expect(check("https://notx.com/")).toBe("OK");
  });
});

describe("query strings", () => {
  it("are passed through, however long or token-like", () => {
    expect(
      check(
        `https://shop.example/search?q=${"a".repeat(200)}&sig=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig`,
      ),
    ).toBe("OK");
  });
});
