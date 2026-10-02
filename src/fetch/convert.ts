import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { FetchError } from "./errors.js";

export interface PageMeta {
  title?: string;
  description?: string;
  modified?: string;
}

export interface Converted extends PageMeta {
  markdown: string;
}

export type ContentKind = "html" | "pdf" | "text";

/** Readability output shorter than this means extraction failed; fall back to the full page. */
const MIN_ARTICLE_CHARS = 200;

const REMOVE = "script, style, noscript, iframe, frame, object, embed, video, audio, canvas, template, svg, link, meta, [hidden]";
const TRACKER_HOSTS = /(^|\.)(googletagmanager\.com|google-analytics\.com|doubleclick\.net|facebook\.com|bat\.bing\.com|px\.ads\.linkedin\.com|analytics\.twitter\.com|t\.co|hotjar\.com|clarity\.ms)$/;

export function kindOf(contentType: string, body: Buffer): ContentKind | undefined {
  const mime = contentType.split(";")[0]!.trim().toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime === "application/pdf" || body.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (mime.startsWith("text/") || /^application\/([\w.+-]+\+)?(json|xml)$/.test(mime)) return "text";
  if (mime === "" || mime === "application/octet-stream") {
    const head = body.subarray(0, 1024).toString("latin1");
    if (/^\s*(<!doctype html|<html|<head|<body)/i.test(head)) return "html";
    if (!head.includes("\0")) return "text";
  }
  return undefined;
}

export function decode(body: Buffer, contentType: string): string {
  const charset =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 4096).toString("latin1"))?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder().decode(body);
  }
}

export async function convert(body: Buffer, contentType: string, baseUrl: string, extractMain: boolean): Promise<Converted> {
  const kind = kindOf(contentType, body);
  if (kind === "html") return htmlToMarkdown(decode(body, contentType), baseUrl, extractMain);
  if (kind === "pdf") {
    return pdfToText(body).catch(() => {
      throw new FetchError("UNSUPPORTED_CONTENT_TYPE", "The PDF could not be read (damaged, encrypted or not really a PDF). Ask the user for another copy.");
    });
  }
  if (kind === "text") return { markdown: decode(body, contentType) };
  throw new FetchError(
    "UNSUPPORTED_CONTENT_TYPE",
    `The URL returned ${contentType.split(";")[0] || "binary data"}, which this tool can't convert. It handles HTML, PDF, JSON and plain text.`,
  );
}

export function htmlToMarkdown(html: string, baseUrl: string, extractMain: boolean): Converted {
  const { document } = parseHTML(html);
  const meta = readMeta(document);
  absolutizeUrls(document, baseUrl);
  clean(document);

  let content: string | undefined;
  if (extractMain) {
    // Readability mutates the DOM it gets, so give it its own copy.
    const copy = parseHTML(document.toString()).document;
    const article = new Readability(copy as unknown as Document).parse();
    if (article?.content && (article.textContent ?? "").trim().length >= MIN_ARTICLE_CHARS) {
      content = article.content;
      meta.title ??= article.title ?? undefined;
    }
  }
  content ??= document.body?.innerHTML ?? document.toString();

  return { ...meta, markdown: tidy(turndown().turndown(content)) };
}

function readMeta(document: Document): PageMeta {
  const meta = (selector: string) => document.querySelector(selector)?.getAttribute("content")?.trim() || undefined;
  return {
    title: meta('meta[property="og:title"]') ?? (document.querySelector("title")?.textContent?.trim() || undefined),
    description: meta('meta[name="description"]') ?? meta('meta[property="og:description"]'),
    modified:
      meta('meta[property="article:modified_time"]') ??
      meta('meta[property="og:updated_time"]') ??
      meta('meta[itemprop="dateModified"]') ??
      jsonLdDateModified(document),
  };
}

function jsonLdDateModified(document: Document): string | undefined {
  const find = (node: unknown): string | undefined => {
    if (Array.isArray(node)) return node.map(find).find(Boolean);
    if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      if (typeof record.dateModified === "string") return record.dateModified;
      return find(record["@graph"]);
    }
    return undefined;
  };
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const found = find(JSON.parse(script.textContent ?? ""));
      if (found) return found;
    } catch {
      // Malformed JSON-LD is common; skip it.
    }
  }
  return undefined;
}

function absolutizeUrls(document: Document, pageUrl: string) {
  let base = pageUrl;
  const baseHref = document.querySelector("base[href]")?.getAttribute("href");
  if (baseHref) {
    try {
      base = new URL(baseHref, pageUrl).href;
    } catch {
      // Keep the page URL.
    }
  }
  for (const [selector, attr] of [
    ["a[href]", "href"],
    ["img[src]", "src"],
  ] as const) {
    for (const el of document.querySelectorAll(selector)) {
      const value = el.getAttribute(attr)!;
      if (value.startsWith("#") || /^(data|javascript|mailto|tel):/i.test(value)) continue;
      try {
        el.setAttribute(attr, new URL(value, base).href);
      } catch {
        el.removeAttribute(attr);
      }
    }
  }
}

function clean(document: Document) {
  for (const el of document.querySelectorAll(REMOVE)) el.remove();
  for (const a of document.querySelectorAll("a[href^='javascript:' i]")) a.removeAttribute("href");
  for (const img of document.querySelectorAll("img")) {
    if (isTrackingOrInline(img)) img.remove();
    else img.removeAttribute("srcset");
  }
}

function isTrackingOrInline(img: Element): boolean {
  const src = img.getAttribute("src") ?? "";
  if (!src || src.startsWith("data:")) return true;
  const tiny = (attr: string) => {
    const value = img.getAttribute(attr);
    return value !== null && Number.parseInt(value, 10) <= 1;
  };
  if (tiny("width") || tiny("height")) return true;
  try {
    return TRACKER_HOSTS.test(new URL(src).hostname);
  } catch {
    return true;
  }
}

let service: TurndownService | undefined;
function turndown(): TurndownService {
  if (service) return service;
  service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "_" });
  service.use(gfm);
  service.remove(["script", "style", "noscript", "iframe", "video", "audio", "canvas", "svg"] as never);
  // Links with no text (icon links) only add noise like [](https://...).
  service.addRule("emptyLink", {
    filter: (node) => node.nodeName === "A" && !node.textContent?.trim() && !node.querySelector("img"),
    replacement: () => "",
  });
  return service;
}

function tidy(markdown: string): string {
  return markdown
    .replace(/[ \t]+$/gm, "")
    .replace(/^#{1,6}$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function pdfToText(body: Buffer): Promise<Converted> {
  const { extractText, getDocumentProxy, getMeta } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(body));
  const [{ text }, { info }] = await Promise.all([extractText(pdf, { mergePages: false }), getMeta(pdf)]);
  const title = typeof info?.Title === "string" && info.Title.trim() ? info.Title.trim() : undefined;
  return { title, markdown: tidy(text.map((page) => page.trim()).join("\n\n")) };
}
