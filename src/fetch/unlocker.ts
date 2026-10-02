import { fetch } from "undici";
import { FetchError } from "./errors.js";

const ENDPOINT = "https://api.brightdata.com/request";
const MAX_ATTEMPT_MS = 70_000;
const MIN_RETRY_MS = 5_000;
export const MAX_BYTES = 15 * 1024 * 1024;

export interface Fetched {
  status: number;
  /** The site's Content-Type, which describes what Bright Data converted, not the Markdown. */
  contentType: string;
  markdown: string;
}

export interface UnlockerOptions {
  apiKey: string;
  zone: string;
  /** Epoch ms by which the call must be finished, retries included. */
  deadline: number;
}

class Retryable extends Error {}

/** Fetches a page as Markdown through Bright Data Web Unlocker. One retry on network or 5xx errors, none on 4xx. */
export async function fetchUnlocker(url: URL, opts: UnlockerOptions): Promise<Fetched> {
  try {
    return await attempt(url, opts);
  } catch (err) {
    if (!(err instanceof Retryable) || opts.deadline - Date.now() < MIN_RETRY_MS) throw toFetchError(err);
    try {
      return await attempt(url, opts);
    } catch (err) {
      throw toFetchError(err);
    }
  }
}

// `format: "raw"` returns Bright Data's Markdown as the body with the site's headers, and the site's status in
// `x-brd-status-code`. A response without that header is Bright Data's own.
async function attempt(url: URL, { apiKey, zone, deadline }: UnlockerOptions): Promise<Fetched> {
  const timeout = Math.min(MAX_ATTEMPT_MS, deadline - Date.now());
  if (timeout <= 0) throw new FetchError("TIMEOUT", "Ran out of time before the unblocking service answered. Try again later.");
  const signal = AbortSignal.timeout(timeout);

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ zone, url: url.href, format: "raw", data_format: "markdown" }),
      signal,
    });
  } catch (err) {
    throw networkError(err);
  }

  const siteStatus = Number(res.headers.get("x-brd-status-code")) || undefined;
  if (!siteStatus && !res.ok) {
    const detail = res.headers.get("x-brd-error") ?? (await res.text().catch(() => "")).slice(0, 200);
    const message = `HTTP ${res.status}${detail ? `: ${detail.replace(/\s+/g, " ")}` : ""}`;
    if (res.status >= 500) throw new Retryable(message);
    throw new FetchError("UNLOCKER_ERROR", `The unblocking service rejected the request (${message}). Tell the user; the server's Bright Data configuration may need fixing.`);
  }

  if (Number(res.headers.get("content-length")) > MAX_BYTES) {
    await res.body?.cancel();
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of res.body ?? []) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) {
        await res.body?.cancel();
        throw tooLarge();
      }
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof FetchError) throw err;
    throw networkError(err);
  }

  return {
    status: siteStatus ?? res.status,
    contentType: res.headers.get("content-type") ?? "",
    markdown: Buffer.concat(chunks).toString("utf8"),
  };
}

const tooLarge = () =>
  new FetchError("TOO_LARGE", `The response is larger than ${MAX_BYTES / 1024 / 1024} MB. This tool can't fetch files this big.`);

function networkError(err: unknown): Error {
  if ((err as Error)?.name === "TimeoutError") {
    return new FetchError("TIMEOUT", "The unblocking service didn't answer in time. Try again later.");
  }
  return new Retryable(`network error: ${(err as { cause?: { code?: string } })?.cause?.code ?? "unknown"}`);
}

function toFetchError(err: unknown): FetchError {
  if (err instanceof FetchError) return err;
  return new FetchError("UNLOCKER_ERROR", `The unblocking service failed (${(err as Error).message}). Try again later.`);
}
