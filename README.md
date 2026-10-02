# aikiddo-mcp

A custom connector for claude.ai: a remote MCP server on AWS Lambda, deployed with [SST](https://sst.dev). You deploy it to your own AWS account and add it to claude.ai by URL.

The server will host several tools. Today it has one, `fetch_page`. It fetches a public web page, first with a direct request and then through [Bright Data Web Unlocker](https://docs.brightdata.com/api-reference/rest-api/unlocker/unlock-website) if the page is blocked or needs JavaScript, and returns clean Markdown.

Access is protected by a secret in the URL path: only someone with the full connector URL can use the server.

## Prerequisites

- Node.js 22 or newer, and npm. The repo pins Node 24 for [Volta](https://volta.sh) users; the test and build tools don't run on Node 20.
- AWS credentials for the account you deploy to. Any method the AWS SDK understands works, for example `aws sso login --profile <name>` followed by `export AWS_PROFILE=<name>`.
- The app deploys to `eu-west-1` (Ireland), to the sandbox account `469819851476` only. Both are set under `providers.aws` in `sst.config.ts`: `allowedAccountIds` makes a deploy with credentials for any other account fail before it changes anything. To deploy to your own account, change that ID.
- A Bright Data account with a Web Unlocker zone and an API key.

## SSM parameters

Secrets live in SSM Parameter Store, under a prefix per SST stage: `/aikiddo-mcp/<stage>/`. Create them by hand **before the first deploy** of a stage. SST never creates them. The deploy also looks up the AWS managed key `alias/aws/ssm`, which AWS creates with the first SecureString parameter.

| Parameter                                   | Type                   | Purpose                                     |
| ------------------------------------------- | ---------------------- | ------------------------------------------- |
| `/aikiddo-mcp/<stage>/url-secret`           | SecureString           | The secret in the connector URL              |
| `/aikiddo-mcp/<stage>/url-secret-previous`  | SecureString, optional | Still accepted during a rotation             |
| `/aikiddo-mcp/<stage>/brightdata-api-key`   | SecureString           | Bright Data API key                          |
| `/aikiddo-mcp/<stage>/brightdata-zone`      | String                 | Web Unlocker zone name, e.g. `web_unlocker1` |

```bash
STAGE=prod
aws ssm put-parameter --name /aikiddo-mcp/$STAGE/url-secret --type SecureString --value "$(openssl rand -hex 32)"
aws ssm put-parameter --name /aikiddo-mcp/$STAGE/brightdata-api-key --type SecureString --value '<your Bright Data API key>'
aws ssm put-parameter --name /aikiddo-mcp/$STAGE/brightdata-zone --type String --value web_unlocker1
```

Read the secret back when you need the connector URL:

```bash
aws ssm get-parameter --name /aikiddo-mcp/$STAGE/url-secret --with-decryption --query Parameter.Value --output text
```

The function caches the parameters for 5 minutes. If a required parameter is missing, `/mcp/...` returns `500 internal error`, and the CloudWatch log names the missing parameter but never a value.

### Rotating the URL secret

No redeploy is needed.

1. Copy the current secret into `url-secret-previous`:
   ```bash
   aws ssm put-parameter --name /aikiddo-mcp/$STAGE/url-secret-previous --type SecureString --value "$(aws ssm get-parameter --name /aikiddo-mcp/$STAGE/url-secret --with-decryption --query Parameter.Value --output text)"
   ```
2. Put a new `url-secret`:
   ```bash
   aws ssm put-parameter --name /aikiddo-mcp/$STAGE/url-secret --type SecureString --overwrite --value "$(openssl rand -hex 32)"
   ```
3. Wait 5 minutes for the cache to expire, or redeploy. Both URLs now work.
4. Update the connector URL in claude.ai.
5. Delete the previous secret. Within 5 minutes only the new URL works.
   ```bash
   aws ssm delete-parameter --name /aikiddo-mcp/$STAGE/url-secret-previous
   ```

## Deploy

```bash
npm install
npx sst deploy --stage prod
```

The deploy prints the Function URL as `url`, for example `https://abc123.lambda-url.eu-west-1.on.aws/`. The MCP endpoint is `<url>mcp/<secret>`.

Check it:

```bash
curl https://<url>/healthz
```

The stage `prod` is protected and its resources are retained, so `sst remove --stage prod` will not delete it by accident. For experiments, use another stage (with its own SSM parameters), then clean it up:

```bash
npx sst deploy --stage dev
npx sst remove --stage dev
```

Deploy-time settings, read from the environment when you run `sst deploy`:

| Variable               | Default      | Effect                                                                                     |
| ---------------------- | ------------ | ------------------------------------------------------------------------------------------ |
| `RESERVED_CONCURRENCY` | `5`          | Lambda reserved concurrency, the cost backstop. `0` disables it (see Gotchas).              |
| `BLOCKED_DOMAINS`      | see below    | Comma-separated domains `fetch_page` refuses, subdomains included. Empty string: none.      |

The default blocklist is `facebook.com, instagram.com, x.com, twitter.com, linkedin.com, tiktok.com`.

## Cost

Every Unlocker request costs money. `fetch_page` only escalates when the direct request is blocked or returns a JavaScript shell, or when the model passes `force_unlocker: true`. A JS shell that comes back unrendered costs a second, rendered request. Two backstops:

- **Set a spend limit in the Bright Data dashboard** for the zone. This is the real cap.
- Lambda reserved concurrency 5 limits how many requests run at once.

## Endpoints

| Path            | Method | Response                                                                  |
| --------------- | ------ | ------------------------------------------------------------------------- |
| `/mcp/<secret>` | POST   | MCP Streamable HTTP, stateless, JSON responses (no SSE)                   |
| `/mcp/<secret>` | other  | `405`                                                                     |
| `/mcp/<wrong>`, `/mcp` | any | `404`, the same as an unknown path: the endpoint's existence isn't confirmed |
| `/healthz`      | GET    | `200 ok`                                                                  |
| anything else   |        | `404`                                                                     |

The secret is compared in constant time against the current and the previous secret. Neither the function nor the MCP SDK logs the request path: the handler passes the SDK the path `/mcp` only. To check that no secret has leaked into the logs:

```bash
aws logs filter-log-events --log-group-name /aws/lambda/<function name> --filter-pattern "\"$(aws ssm get-parameter --name /aikiddo-mcp/$STAGE/url-secret --with-decryption --query Parameter.Value --output text)\"" --query 'events[].message'
```

## The `fetch_page` tool

Input: `url` (required), `include_frontmatter` (default `true`), `extract_main_content` (default `true`), `max_tokens` (500–100000, default 20000), `force_unlocker` (default `false`).

Pipeline:

1. **Safety.** Only `http`/`https`. Refuses `localhost`, `*.localhost`, `*.internal`, and any host that resolves to a private, loopback, link-local or reserved address, IPv4 or IPv6. The URL parser normalizes decimal, octal and hex IPv4 forms first, and the address the socket connects to is checked again, so DNS rebinding doesn't get through. Also refuses blocklisted domains, and query strings with values that look like smuggled data: longer than 64 characters, emails, tokens, hex or base64 blobs.
2. **Direct fetch** with a Chrome user agent: 15 s timeout, 15 MB cap, at most 10 redirects followed manually, with the safety checks repeated on every hop.
3. **Detection** (`src/fetch/detect.ts`). *Blocked* means status 401/403/429/503, or a bot-protection marker such as a Cloudflare challenge, DataDome or reCAPTCHA. *JS shell* means "enable JavaScript" on an almost empty page, or a large page with almost no text and an empty `#root`/`#app`/`#__next`. A direct request that times out or gets reset also counts as blocked.
4. **Unlocker** on a block, a JS shell (with `render`) or `force_unlocker`. One retry on network or 5xx errors. A challenge that still comes back is an error.
5. **Convert.** HTML goes through Readability, then Turndown with GFM tables. If extraction yields under 200 characters, it falls back to the full page. Links become absolute. Scripts, styles, iframes, video, tracking pixels and inline images are dropped. PDFs become text. JSON and plain text are returned as-is.
6. **Truncate** to about `max_tokens` (4 characters per token), at a paragraph boundary.

Output is Markdown with YAML front matter (`url`, `final_url`, `title`, `description`, `modified`, `status_code`, `fetched_via`, `escalation_reason`, `truncated`, `approx_tokens`; empty keys are omitted). Errors are tool results with `isError: true` and one line, `ERROR <CODE>: <reason and what to do>`. The codes are `INVALID_URL`, `SSRF_BLOCKED`, `DOMAIN_BLOCKED`, `SUSPICIOUS_QUERY`, `TIMEOUT`, `BLOCKED_AFTER_UNLOCKER`, `UNLOCKER_ERROR`, `UNSUPPORTED_CONTENT_TYPE`, `TOO_LARGE` and `HTTP_ERROR`.

## Tests

```bash
npm test
npm run typecheck
```

Unit tests use saved fixtures in `test/fixtures/` and make no network calls.

## Test with MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Choose transport **Streamable HTTP**, enter `https://<url>/mcp/<secret>`, and connect. **Tools → List Tools** shows `fetch_page`. Run it with `https://brightdata.com/products/web-unlocker`.

## Add to claude.ai

1. Go to **Settings → Connectors → Add custom connector**. On Team and Enterprise plans, an owner adds it under **Organization settings → Connectors** first.
2. Name: `aikiddo-mcp`. URL: `https://<url>/mcp/<secret>`. Leave the OAuth fields empty.
3. In a new chat, enable the connector from the tools menu and ask: "Fetch https://brightdata.com/products/web-unlocker with fetch_page and summarize the pricing."

## Layout

- `sst.config.ts`: the Lambda function (Node 24, 1024 MB, 90 s, public Function URL), its SSM/KMS permissions and reserved concurrency.
- `src/handler.ts`: routing, the URL-secret check, and the adapter between the Lambda Function URL event and the MCP SDK's web-standard transport.
- `src/config.ts`: loads the SSM parameters, cached for 5 minutes.
- `src/tools/fetchPage.ts`: the `fetch_page` tool and its pipeline.
- `src/fetch/`: the pipeline's parts: `safety.ts`, `http.ts` (direct fetch), `detect.ts`, `unlocker.ts`, `convert.ts`, `output.ts`.

## Gotchas

- **The stage `prod` is not the production AWS account.** It is only the SST stage name. Every stage deploys to the account in `allowedAccountIds`, which is the sandbox account.
- **SST v4, not v3.** `npx sst@latest init` now installs SST v4. v4 only moves to the Pulumi AWS provider v7; SST components such as `sst.aws.Function` have the same API as in v3.
- **`sst init` prompts even with `--yes`.** It asks for the provider (aws or cloudflare) and needs a terminal to answer.
- **No Express adapter needed.** The MCP SDK ships `WebStandardStreamableHTTPServerTransport`, which maps a web `Request` to a `Response`. The handler converts the Function URL event to a `Request` and the `Response` back to the Lambda result. Bodies can arrive base64-encoded, so the handler decodes them.
- **Stateless means a new server per request.** The SDK rejects reusing a stateless transport across requests, so each invocation creates its own `McpServer` and transport.
- **GET `/mcp/<secret>` returns 405.** In stateless JSON mode there is no standalone SSE stream, and the spec allows a server to return 405 for GET.
- **POST needs both Accept types.** The transport returns 406 unless `Accept` includes both `application/json` and `text/event-stream`. Inspector and claude.ai send both; plain `curl` tests have to set the header.
- **Reserved concurrency fails on new accounts.** AWS refuses a reservation that leaves fewer than 10 unreserved executions, and new accounts have a total limit of 10 (the sandbox account does). Deploy with `RESERVED_CONCURRENCY=0` there, or request a higher Lambda concurrency quota.
- **Block markers only count on small pages.** Many normal pages embed reCAPTCHA or DataDome scripts, or talk about CAPTCHAs (the Bright Data test page does). A marker counts only if the page has under 2000 characters of visible text, or if it appears in the `<title>`.
- **Redirect hops skip the query guard.** It exists to stop the model from smuggling data into URLs it writes. Server-issued redirects legitimately carry long tokens. The SSRF checks and the domain blocklist still run on every hop.
