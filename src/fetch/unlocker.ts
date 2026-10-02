import { FetchError } from "./errors.js";

const ENDPOINT = "https://api.brightdata.com/request";
// 30 s for the request plus 5 s for Bright Data to render JavaScript. Two attempts plus 5 s of our own work
// set the Lambda timeout in sst.config.ts.
export const ATTEMPT_MS = 35_000;
const ATTEMPTS = 2;

export interface Fetched {
  status: number;
  /** The site's Content-Type, which describes what Bright Data converted, not the Markdown. */
  contentType: string;
  markdown: string;
  /** False if reading stopped at maxBytes(), so the page's full length is unknown. */
  complete: boolean;
}

export interface UnlockerOptions {
  apiKey: string;
  zone: string;
}

/**
 * A last-resort cap on the body, from the Lambda's memory (AWS_LAMBDA_FUNCTION_MEMORY_SIZE, in MB): an eighth of it.
 * Reading N bytes peaks at about 4N (the chunks, their concatenation, and the UTF-16 string), so half stays free.
 * Bright Data sends no Content-Length, so the full body is read to know the page's length.
 */
export function maxBytes(): number {
  return ((Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE) || 1024) * 1024 * 1024) / 8;
}

class Retryable extends Error {}

/** Fetches a page as Markdown through Bright Data Web Unlocker. Retries once on a timeout, network or 5xx error. */
export async function fetchUnlocker(url: URL, opts: UnlockerOptions): Promise<Fetched> {
  for (let attemptNo = 1; ; attemptNo++) {
    try {
      return await attempt(url, opts);
    } catch (err) {
      // Anything else is a FetchError to report as-is, or a bug for the tool's catch-all to log.
      if (!(err instanceof Retryable)) throw err;
      if (attemptNo >= ATTEMPTS) {
        throw new FetchError("INTERNAL_ERROR", `The unblocking service failed twice (${(err as Error).message}). Try again later.`);
      }
    }
  }
}

// `format: "raw"` returns Bright Data's Markdown as the body with the site's headers, and the site's status in
// `x-brd-status-code`. A response without that header is Bright Data's own.
async function attempt(url: URL, { apiKey, zone }: UnlockerOptions): Promise<Fetched> {
  // Covers reading the body too.
  const signal = AbortSignal.timeout(ATTEMPT_MS);

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ zone, url: url.href, format: "raw", data_format: "markdown" }),
      signal,
    });
  } catch (err) {
    throw retryable(err);
  }

  const siteStatus = Number(res.headers.get("x-brd-status-code")) || undefined;
  if (!siteStatus && !res.ok) {
    const detail = res.headers.get("x-brd-error") ?? (await res.text().catch(() => "")).slice(0, 200);
    const message = `HTTP ${res.status}${detail ? `: ${detail.replace(/\s+/g, " ")}` : ""}`;
    if (res.status >= 500) throw new Retryable(message);
    throw new FetchError(
      "INTERNAL_ERROR",
      `The unblocking service rejected the request (${message}). Tell the user; the server's Bright Data configuration may need fixing.`,
    );
  }

  const limit = maxBytes();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = true;
  try {
    for await (const chunk of res.body ?? []) {
      chunks.push(chunk);
      size += chunk.byteLength;
      // Leaving the loop cancels the stream.
      if (size > limit) {
        complete = false;
        break;
      }
    }
  } catch (err) {
    throw retryable(err);
  }

  return {
    status: siteStatus ?? res.status,
    contentType: res.headers.get("content-type") ?? "",
    markdown: Buffer.concat(chunks).subarray(0, limit).toString("utf8"),
    complete,
  };
}

function retryable(err: unknown): Retryable {
  if ((err as Error)?.name === "TimeoutError") return new Retryable(`no answer within ${ATTEMPT_MS / 1000} s`);
  return new Retryable(`network error: ${(err as { cause?: { code?: string } })?.cause?.code ?? "unknown"}`);
}
