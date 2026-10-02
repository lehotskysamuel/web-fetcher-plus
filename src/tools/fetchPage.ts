import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { convert, decode, kindOf } from "../fetch/convert.js";
import { detect, detectBlock } from "../fetch/detect.js";
import { FetchError } from "../fetch/errors.js";
import { DirectNetworkBlock, fetchDirect, type Fetched } from "../fetch/http.js";
import { approxTokens, frontMatter, truncate } from "../fetch/output.js";
import { checkUrl, DEFAULT_BLOCKED_DOMAINS } from "../fetch/safety.js";
import { fetchUnlocker } from "../fetch/unlocker.js";

const DESCRIPTION = `Fetch a public web page. Use when the built-in web fetch fails, returns a CAPTCHA/access-denied page, or an empty JavaScript shell. Tries a direct request first and escalates to a paid unblocking service only when needed, so don't refetch the same URL without reason.

Only fetch URLs the user gave you or that appeared in a previous tool result. Don't construct or modify URLs (e.g. adding query parameters); such requests may be rejected.

Returns the page's main content as Markdown with a YAML front matter block (final URL, title, fetch path, truncation). Cannot log in, click or submit forms.`;

// Leaves headroom inside the 90 s Lambda timeout.
const BUDGET_MS = 85_000;

export interface FetchPageArgs {
  url: string;
  include_frontmatter: boolean;
  extract_main_content: boolean;
  max_tokens: number;
  force_unlocker: boolean;
}

export function blockedDomains(): string[] {
  const env = process.env.BLOCKED_DOMAINS;
  if (env === undefined) return DEFAULT_BLOCKED_DOMAINS;
  return env
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export function registerFetchPage(server: McpServer, config: Config) {
  server.registerTool(
    "fetch_page",
    {
      title: "Fetch page",
      description: DESCRIPTION,
      inputSchema: {
        url: z.string().describe("Absolute http(s) URL. Must come from the user or a previous tool result."),
        include_frontmatter: z
          .boolean()
          .default(true)
          .describe("Prepend YAML metadata (final URL, title, fetch path, status, truncation)."),
        extract_main_content: z
          .boolean()
          .default(true)
          .describe("Strip navigation, footers and boilerplate. Set false if you need nav/footer content."),
        max_tokens: z
          .number()
          .int()
          .min(500)
          .max(100000)
          .default(20000)
          .describe("Approximate max size of returned text; longer content is truncated and flagged."),
        force_unlocker: z
          .boolean()
          .default(false)
          .describe("Skip the direct request. Use only if you already know the site blocks bots. Costs money every call."),
      },
      annotations: { title: "Fetch page", readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        return { content: [{ type: "text", text: await fetchPage(args, config) }] };
      } catch (err) {
        if (!(err instanceof FetchError)) console.error("fetch_page failed", err);
        const error =
          err instanceof FetchError ? err : new FetchError("HTTP_ERROR", "Unexpected failure while processing the page. Try again later.");
        return { isError: true, content: [{ type: "text", text: error.toString() }] };
      }
    },
  );
}

export async function fetchPage(args: FetchPageArgs, config: Config): Promise<string> {
  const deadline = Date.now() + BUDGET_MS;
  const domains = blockedDomains();
  const url = checkUrl(args.url, domains);

  let fetched: Fetched | undefined;
  let escalation: string | undefined;
  if (args.force_unlocker) {
    escalation = "forced";
  } else {
    try {
      fetched = await fetchDirect(url, domains);
      escalation = escalationReason(fetched);
    } catch (err) {
      if (!(err instanceof DirectNetworkBlock)) throw err;
      escalation = `blocked:${err.reason}`;
    }
  }

  if (escalation) {
    const unlock = (render: boolean) =>
      fetchUnlocker(url, { apiKey: config.brightdataApiKey, zone: config.brightdataZone, render, deadline });
    const render = escalation === "js_shell";
    fetched = await unlock(render);
    // A forced or block-triggered fetch can still come back as a JS shell; one rendered retry fixes that.
    if (!render && escalationReason(fetched) === "js_shell") fetched = await unlock(true);

    const stillBlocked = escalationReason(fetched);
    if (stillBlocked && stillBlocked !== "js_shell") {
      throw new FetchError(
        "BLOCKED_AFTER_UNLOCKER",
        `The site still served a bot challenge (${stillBlocked}) through the unblocking service. Tell the user the page can't be fetched right now.`,
      );
    }
  }
  fetched = fetched!;

  if (fetched.status >= 400) {
    throw new FetchError("HTTP_ERROR", `The site answered HTTP ${fetched.status}. Check that the URL is correct; don't retry the same URL.`);
  }

  const page = await convert(fetched.body, fetched.contentType, fetched.finalUrl, args.extract_main_content);
  const { text, truncated } = truncate(page.markdown, args.max_tokens);
  const tokens = approxTokens(text);

  if (!args.include_frontmatter) return truncated ? `${text}\n\n[... truncated at ~${tokens} tokens]` : text;
  return (
    frontMatter({
      url: url.href,
      final_url: fetched.finalUrl,
      title: page.title,
      description: page.description,
      modified: page.modified,
      status_code: fetched.status,
      fetched_via: escalation ? "unlocker" : "direct",
      escalation_reason: escalation,
      truncated,
      approx_tokens: tokens,
    }) + text
  );
}

/** Why a response needs the Unlocker: `blocked:<marker>`, `js_shell`, or undefined if it is usable. */
function escalationReason(fetched: Fetched): string | undefined {
  if (kindOf(fetched.contentType, fetched.body) !== "html") {
    const blocked = detectBlock(fetched.status, "");
    return blocked && `blocked:${blocked}`;
  }
  const detection = detect(fetched.status, decode(fetched.body, fetched.contentType));
  if (!detection) return undefined;
  return "blocked" in detection ? `blocked:${detection.blocked}` : "js_shell";
}
