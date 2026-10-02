import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detect, detectBlock, isJsShell } from "../src/fetch/detect.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("detect", () => {
  it("flags a Cloudflare challenge", () => {
    expect(detect(403, fixture("cloudflare.html"))).toEqual({ blocked: "http_403" });
    // Same page with a 200: the markers alone are enough.
    expect(detectBlock(200, fixture("cloudflare.html"))).toBe("Just a moment...");
  });

  it("flags a DataDome block page", () => {
    expect(detect(200, fixture("datadome.html"))).toEqual({ blocked: "datadome" });
  });

  it("flags block statuses regardless of body", () => {
    for (const status of [401, 403, 429, 503]) expect(detectBlock(status, "")).toBe(`http_${status}`);
    expect(detectBlock(404, "")).toBeUndefined();
  });

  it("flags an empty React shell as a JS shell", () => {
    expect(detect(200, fixture("react-shell.html"))).toEqual({ jsShell: true });
  });

  it("flags a large page with an empty #__next and no text as a JS shell", () => {
    expect(isJsShell(fixture("next-shell.html"))).toBe(true);
  });

  it("passes a normal article", () => {
    expect(detect(200, fixture("article.html"))).toBeNull();
  });

  it("passes a normal page that talks about captchas and embeds reCAPTCHA", () => {
    expect(detect(200, fixture("captcha-mention.html"))).toBeNull();
  });

  it("passes a long page with a noscript 'enable JavaScript' banner", () => {
    const html = fixture("article.html").replace("<main>", "<noscript>Please enable JavaScript for the best experience.</noscript><main>");
    expect(detect(200, html)).toBeNull();
  });
});
