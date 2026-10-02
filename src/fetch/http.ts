import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { Agent, fetch } from "undici";
import { FetchError } from "./errors.js";
import { checkHostResolves, checkUrl, isPublicIp } from "./safety.js";

export interface Fetched {
  finalUrl: string;
  status: number;
  contentType: string;
  body: Buffer;
}

const TIMEOUT_MS = 15_000;
export const MAX_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

class PrivateAddressError extends Error {}

// Checks the addresses the socket actually connects to, so a DNS answer that changes between our
// check and the connection (DNS rebinding) can't reach a private address.
const agent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dnsLookup(hostname, options, (err, address: string | LookupAddress[], family?: number) => {
        if (err) return callback(err, address as string, family);
        const all = typeof address === "string" ? [address] : address.map((a) => a.address);
        if (all.some((a) => !isPublicIp(a))) {
          return callback(new PrivateAddressError(hostname), "", 0);
        }
        callback(null, address as string, family);
      });
    },
  },
});

/** Thrown when the direct request looks blocked at the network level (tarpit or reset). */
export class DirectNetworkBlock extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** GET with browser-like headers, manual redirects (each hop re-checked), a 15 s timeout and a 15 MB cap. */
export async function fetchDirect(start: URL, blockedDomains: string[]): Promise<Fetched> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let url = start;

  for (let hop = 0; ; hop++) {
    await checkHostResolves(url);
    let res;
    try {
      res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "manual", signal, dispatcher: agent });
    } catch (err) {
      throw networkError(err, url);
    }

    const location = res.headers.get("location");
    if (REDIRECT_STATUSES.has(res.status) && location) {
      await res.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new FetchError("HTTP_ERROR", `More than ${MAX_REDIRECTS} redirects. The site is redirecting in a loop.`);
      // The query guard targets URLs the model writes; server-issued redirects legitimately carry long tokens.
      url = checkUrl(new URL(location, url).href, blockedDomains, { checkQuery: false });
      continue;
    }

    const declared = Number(res.headers.get("content-length"));
    if (declared > MAX_BYTES) {
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
      throw networkError(err, url);
    }

    return {
      finalUrl: url.href,
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body: Buffer.concat(chunks),
    };
  }
}

const tooLarge = () =>
  new FetchError("TOO_LARGE", `The response is larger than ${MAX_BYTES / 1024 / 1024} MB. This tool can't fetch files this big.`);

function networkError(err: unknown, url: URL): Error {
  const cause = (err as { cause?: unknown })?.cause;
  if (cause instanceof PrivateAddressError || err instanceof PrivateAddressError) {
    return new FetchError("SSRF_BLOCKED", `${url.hostname} resolves to a private or reserved address. Only public web pages can be fetched.`);
  }
  if ((err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError") {
    return new DirectNetworkBlock("timeout");
  }
  const code = (cause as { code?: string })?.code ?? "";
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return new DirectNetworkBlock("connection_reset");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new FetchError("HTTP_ERROR", `Could not resolve ${url.hostname}. Check the URL for typos.`);
  }
  return new FetchError("HTTP_ERROR", `Request to ${url.hostname} failed (${code || "network error"}). The site may be down; try again later.`);
}
