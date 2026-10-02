import { fetch } from "undici";
import { FetchError } from "./errors.js";
import type { Fetched } from "./http.js";

const ENDPOINT = "https://api.brightdata.com/request";
const MAX_ATTEMPT_MS = 70_000;
const MIN_RETRY_MS = 5_000;

export interface UnlockerOptions {
  apiKey: string;
  zone: string;
  render: boolean;
  /** Epoch ms by which the call must be finished, retries included. */
  deadline: number;
}

interface UnlockerResponse {
  status_code: number;
  headers?: Record<string, string>;
  body: string;
}

class Retryable extends Error {}

/** Fetches through Bright Data Web Unlocker. One retry on network or 5xx errors, none on 4xx. */
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

async function attempt(url: URL, { apiKey, zone, render, deadline }: UnlockerOptions): Promise<Fetched> {
  const timeout = Math.min(MAX_ATTEMPT_MS, deadline - Date.now());
  if (timeout <= 0) throw new FetchError("TIMEOUT", "Ran out of time before the unblocking service answered. Try again later.");

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ zone, url: url.href, format: "json", ...(render && { render: "true" }) }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    if ((err as Error)?.name === "TimeoutError") {
      throw new FetchError("TIMEOUT", "The unblocking service didn't answer in time. Try again later.");
    }
    throw new Retryable(`network error: ${(err as { cause?: { code?: string } })?.cause?.code ?? "unknown"}`);
  }

  if (!res.ok) {
    const detail = res.headers.get("x-brd-error") ?? (await res.text().catch(() => "")).slice(0, 200);
    const message = `HTTP ${res.status}${detail ? `: ${detail.replace(/\s+/g, " ")}` : ""}`;
    if (res.status >= 500) throw new Retryable(message);
    throw new FetchError("UNLOCKER_ERROR", `The unblocking service rejected the request (${message}). Tell the user; the server's Bright Data configuration may need fixing.`);
  }

  let data: UnlockerResponse;
  try {
    data = (await res.json()) as UnlockerResponse;
  } catch {
    throw new Retryable("invalid JSON response");
  }
  if (typeof data?.status_code !== "number" || typeof data.body !== "string") throw new Retryable("unexpected response shape");

  const headers = Object.fromEntries(Object.entries(data.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    finalUrl: url.href,
    status: data.status_code,
    contentType: headers["content-type"] ?? "",
    body: Buffer.from(data.body, "utf8"),
  };
}

function toFetchError(err: unknown): FetchError {
  if (err instanceof FetchError) return err;
  return new FetchError("UNLOCKER_ERROR", `The unblocking service failed (${(err as Error).message}). Try again later.`);
}
