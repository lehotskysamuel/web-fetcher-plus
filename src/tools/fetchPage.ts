import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ParameterNotFoundError } from "@aws-lambda-powertools/parameters/errors";
import { z } from "zod";
import { FetchError } from "../fetch/errors.js";
import { approxTokens, frontMatter, truncate } from "../fetch/output.js";
import { checkUrl, DEFAULT_BLOCKED_DOMAINS } from "../fetch/safety.js";
import { fetchUnlocker } from "../fetch/unlocker.js";
import { getSecret } from "../utils/aws.js";

export const BRIGHTDATA_API_KEY_NAME = "brightdata-api-key";
export const BRIGHTDATA_ZONE_NAME = "brightdata-zone";

const DESCRIPTION = `Fetch a public web page through a paid unblocking service. A fallback: use it only after the built-in web fetch failed on this URL, e.g. it returned a CAPTCHA/access-denied page, an error such as 403, or an empty JavaScript shell. Never use it as the first attempt. Every call costs money, so don't refetch the same URL without reason.

Only fetch URLs the user gave you or that appeared in a previous tool result. Don't construct or modify URLs (e.g. adding query parameters); such requests may be rejected.

Returns the whole page as Markdown, navigation included, with a YAML front matter block (URL, status, truncation). Doesn't handle PDFs or other binary files; the built-in web fetch reads PDFs directly. Cannot log in, click or submit forms.`;

// Leaves headroom inside the 90 s Lambda timeout.
const BUDGET_MS = 85_000;

// Bright Data's Markdown conversion only works on text; for a PDF it returns the raw bytes.
const TEXT_TYPE = /^(text\/|application\/([\w.+-]+\+)?(json|xml)$|$)/;

export interface FetchPageArgs {
  url: string;
  include_frontmatter: boolean;
  max_tokens: number;
}

export function blockedDomains(): string[] {
  const env = process.env.BLOCKED_DOMAINS;
  if (env === undefined) return DEFAULT_BLOCKED_DOMAINS;
  return env
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export function registerFetchPage(server: McpServer) {
  server.registerTool(
    "fetch_blocked_page",
    {
      title: "Fetch blocked page (web fetch fallback)",
      description: DESCRIPTION,
      inputSchema: {
        url: z
          .string()
          .describe(
            "Absolute http(s) URL. Must come from the user or a previous tool result.",
          ),
        include_frontmatter: z
          .boolean()
          .default(true)
          .describe("Prepend YAML metadata (URL, status, truncation)."),
        max_tokens: z
          .number()
          .int()
          .min(500)
          .max(100000)
          .default(20000)
          .describe(
            "Approximate max size of returned text; longer content is truncated and flagged.",
          ),
      },
      annotations: {
        title: "Fetch blocked page (web fetch fallback)",
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        return { content: [{ type: "text", text: await fetchPage(args) }] };
      } catch (err) {
        if (!(err instanceof FetchError))
          console.error("fetch_blocked_page failed", err);
        const error =
          err instanceof FetchError
            ? err
            : new FetchError(
                "HTTP_ERROR",
                "Unexpected failure while processing the page. Try again later.",
              );
        return {
          isError: true,
          content: [{ type: "text", text: error.toString() }],
        };
      }
    },
  );
}

export async function fetchPage(args: FetchPageArgs): Promise<string> {
  const deadline = Date.now() + BUDGET_MS;
  const url = checkUrl(args.url, blockedDomains());
  // Skips the paid request in the obvious case; a PDF without the extension is caught by its Content-Type below.
  if (/\.pdf$/i.test(url.pathname)) throw pdfError();
  const { apiKey, zone } = await brightDataConfig();

  // Bright Data does the unblocking and decides when a page needs a browser to render.
  const fetched = await fetchUnlocker(url, { apiKey, zone, deadline });
  if (fetched.status >= 400) {
    throw new FetchError(
      "HTTP_ERROR",
      `The site answered HTTP ${fetched.status} through the unblocking service. Check that the URL is correct, then tell the user the page can't be fetched; don't retry the same URL.`,
    );
  }
  const mime = fetched.contentType.split(";")[0]!.trim().toLowerCase();
  if (mime === "application/pdf") throw pdfError();
  if (!TEXT_TYPE.test(mime)) {
    throw new FetchError(
      "UNSUPPORTED_CONTENT_TYPE",
      `The URL returned ${mime}, which this tool can't convert. It handles web pages, JSON and plain text.`,
    );
  }

  const { text, truncated } = truncate(fetched.markdown, args.max_tokens);
  const tokens = approxTokens(text);

  if (!args.include_frontmatter)
    return truncated ? `${text}\n\n[... truncated at ~${tokens} tokens]` : text;
  return (
    frontMatter({
      url: url.href,
      status_code: fetched.status,
      truncated,
      approx_tokens: tokens,
    }) + text
  );
}

async function brightDataConfig(): Promise<{ apiKey: string; zone: string }> {
  const notConfigured = new FetchError(
    "UNLOCKER_ERROR",
    "The unblocking service isn't configured on this server. Tell the user the page can't be fetched until a Bright Data key and zone are set up.",
  );
  try {
    const [apiKey, zone] = await Promise.all([
      getSecret(BRIGHTDATA_API_KEY_NAME),
      getSecret(BRIGHTDATA_ZONE_NAME),
    ]);
    if (!apiKey || !zone) throw notConfigured;
    return { apiKey, zone };
  } catch (err) {
    if (err instanceof ParameterNotFoundError) throw notConfigured;
    throw err;
  }
}

const pdfError = () =>
  new FetchError(
    "UNSUPPORTED_CONTENT_TYPE",
    "This is a PDF, which this tool can't read. Use the built-in web fetch, which reads PDFs directly; if that fails too, tell the user.",
  );
