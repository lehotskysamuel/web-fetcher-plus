# aikiddo-mcp

A custom connector for claude.ai: a remote MCP server on AWS Lambda, deployed with [SST](https://sst.dev). You deploy it to your own AWS account and add it to claude.ai by URL.

The server will host several tools. Today it has two: `hello`, which checks that the connector works, and `fetch_page`. It fetches a public web page, first with a direct request and then through [Bright Data Web Unlocker](https://docs.brightdata.com/api-reference/rest-api/unlocker/unlock-website) if the page is blocked or needs JavaScript, and returns clean Markdown.

Access is protected by a shared secret sent as a bearer token, `Authorization: Bearer <secret>`: only a client that sends it can use the server.

## Prerequisites

- Node.js 22 or newer, and npm. The repo pins Node 24 for [Volta](https://volta.sh) users; the test and build tools don't run on Node 20.
- AWS credentials for the account you deploy to. Any method the AWS SDK understands works, for example `aws sso login --profile <name>` followed by `export AWS_PROFILE=<name>`.
- The app deploys to `eu-west-1` (Ireland), to the sandbox account `469819851476` only. Both are set under `providers.aws` in `sst.config.ts`: `allowedAccountIds` makes a deploy with credentials for any other account fail before it changes anything. To deploy to your own account, change that ID.
- Optional: a Bright Data account with a Web Unlocker zone and an API key, for pages that block direct requests.

## SSM parameters

Secrets live in SSM Parameter Store, under a prefix per SST stage: `/aikiddo-mcp/<stage>/`. Create them by hand **before the first deploy** of a stage. SST never creates them. The deploy also looks up the AWS managed key `alias/aws/ssm`, which AWS creates with the first SecureString parameter.

| Parameter                                   | Type                   | Purpose                                     |
| ------------------------------------------- | ---------------------- | ------------------------------------------- |
| `/aikiddo-mcp/<stage>/mcp-secret`           | SecureString           | The bearer token in the `Authorization` header |
| `/aikiddo-mcp/<stage>/brightdata-api-key`   | SecureString, optional | Bright Data API key                          |
| `/aikiddo-mcp/<stage>/brightdata-zone`      | String, optional       | Web Unlocker zone name, e.g. `web_unlocker1` |

Without the Bright Data parameters, everything works except escalation: a page that needs the Unlocker returns `UNLOCKER_ERROR`.

```bash
STAGE=prod
aws ssm put-parameter --name /aikiddo-mcp/$STAGE/brightdata-api-key --type SecureString --value '<your Bright Data API key>'
aws ssm put-parameter --name /aikiddo-mcp/$STAGE/brightdata-zone --type String --value web_unlocker1
```

### The MCP secret

Create it for a new stage:

```bash
aws ssm put-parameter --name /aikiddo-mcp/$STAGE/mcp-secret --type SecureString --value "$(openssl rand -hex 32)"
```

Print the current value, e.g. to configure a client:

```bash
aws ssm get-parameter --name /aikiddo-mcp/$STAGE/mcp-secret --with-decryption --query Parameter.Value --output text
```

Rotate it by overwriting it with a new value, then update the bearer token in every client. Only one secret is accepted at a time. Because of the 5-minute cache, the server can keep accepting the old value, and rejecting the new one, for up to 5 minutes. A redeploy switches it right away.

```bash
aws ssm put-parameter --name /aikiddo-mcp/$STAGE/mcp-secret --type SecureString --overwrite --value "$(openssl rand -hex 32)"
```

The function reads each parameter only when it needs it (the Bright Data ones only on an Unlocker escalation) and caches it for 5 minutes. If `mcp-secret` is missing, `/mcp` returns `500 internal error`, and the CloudWatch log names the missing parameter but never a value.

## Deploy

```bash
npm install
npx sst deploy --stage prod
```

The deploy prints the Function URL as `url`, for example `https://abc123.lambda-url.eu-west-1.on.aws/`. The MCP endpoint is `<url>mcp`, with the header `Authorization: Bearer <secret>`.

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
| `BLOCKED_DOMAINS`      | see below    | Comma-separated domains `fetch_page` refuses, subdomains included. Empty string: none.      |

The default blocklist is `facebook.com, instagram.com, x.com, twitter.com, linkedin.com, tiktok.com`.

## Cost

Every Unlocker request costs money. `fetch_page` only escalates when the direct request is blocked or returns a JavaScript shell, or when the model passes `force_unlocker: true`. A JS shell that comes back unrendered costs a second, rendered request.

**Set a spend limit in the Bright Data dashboard** for the zone. That is the cost cap. There is deliberately no Lambda reserved concurrency: it only limits parallel calls, not total spend, and new AWS accounts (limit 10) can't reserve any.

## Endpoints

| Path            | Method | Response                                                                  |
| --------------- | ------ | ------------------------------------------------------------------------- |
| `/mcp`          | POST   | MCP Streamable HTTP, stateless, JSON responses (no SSE)                   |
| `/mcp`          | other  | `405`                                                                     |
| `/mcp` without the right `Authorization: Bearer` | any | `401`                                         |
| `/healthz`      | GET    | `200 ok`                                                                  |
| anything else   |        | `404`                                                                     |

The bearer token is compared in constant time against the secret. Neither the function nor the MCP SDK logs request headers, and the handler strips `Authorization` before it hands the request to the SDK. To check that no secret has leaked into the logs (SST names the log group differently from the function, so look it up):

```bash
LOG_GROUP=$(aws lambda get-function-configuration --function-name <function name> --query LoggingConfig.LogGroup --output text)
aws logs filter-log-events --log-group-name "$LOG_GROUP" --filter-pattern "\"$(aws ssm get-parameter --name /aikiddo-mcp/$STAGE/mcp-secret --with-decryption --query Parameter.Value --output text)\"" --query 'events[].message'
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

Choose transport **Streamable HTTP**, enter `https://<url>/mcp`, under **Authentication** set the bearer token (or the custom header `Authorization: Bearer <secret>`), and connect. **Tools → List Tools** shows `hello` and `fetch_page`. Run `hello` to check the connection, then `fetch_page` with `https://brightdata.com/products/web-unlocker`.

## Add to claude.ai

1. Go to **Settings → Connectors → Add custom connector**. On Team and Enterprise plans, an owner adds it under **Organization settings → Connectors** first.
2. Name: `aikiddo-mcp`. URL: `https://<url>/mcp`. Under **Authentication**, choose **No sign-in** and enter the secret as the API key, so that Claude sends `Authorization: Bearer <secret>`.
3. In a new chat, enable the connector from the tools menu and ask: "Fetch https://brightdata.com/products/web-unlocker with fetch_page and summarize the pricing."

## Layout

- `sst.config.ts`: the Lambda function (Node 24, 1024 MB, 90 s, public Function URL), and its SSM/KMS permissions.
- `src/handler.ts`: routing, the bearer-token check, and the adapter between the Lambda Function URL event and the MCP SDK's web-standard transport.
- `src/utils/aws.ts`: `getSecret`, which reads one SSM parameter with Powertools Parameters, cached for 5 minutes, plus the Lambda event/response adapters. Each file names the parameters it needs at the top and loads them where it uses them.
- `src/tools/hello.ts`: the `hello` tool.
- `src/tools/fetchPage.ts`: the `fetch_page` tool and its pipeline.
- `src/fetch/`: the pipeline's parts: `safety.ts`, `http.ts` (direct fetch), `detect.ts`, `unlocker.ts`, `convert.ts`, `output.ts`.

## Gotchas

- **The stage `prod` is not the production AWS account.** It is only the SST stage name. Every stage deploys to the account in `allowedAccountIds`, which is the sandbox account.
- **SST v4, not v3.** `npx sst@latest init` now installs SST v4. v4 only moves to the Pulumi AWS provider v7; SST components such as `sst.aws.Function` have the same API as in v3.
- **`sst init` prompts even with `--yes`.** It asks for the provider (aws or cloudflare) and needs a terminal to answer.
- **No Express adapter needed.** The MCP SDK ships `WebStandardStreamableHTTPServerTransport`, which maps a web `Request` to a `Response`. The handler converts the Function URL event to a `Request` and the `Response` back to the Lambda result. Bodies can arrive base64-encoded, so the handler decodes them.
- **Stateless means a new server per request.** The SDK rejects reusing a stateless transport across requests, so each invocation creates its own `McpServer` and transport.
- **GET `/mcp` returns 405.** In stateless JSON mode there is no standalone SSE stream, and the spec allows a server to return 405 for GET.
- **POST needs both Accept types.** The transport returns 406 unless `Accept` includes both `application/json` and `text/event-stream`. Inspector and claude.ai send both; plain `curl` tests have to set the header.
- **Block markers only count on small pages.** Many normal pages embed reCAPTCHA or DataDome scripts, or talk about CAPTCHAs (the Bright Data test page does). A marker counts only if the page has under 2000 characters of visible text, or if it appears in the `<title>`.
- **Redirect hops skip the query guard.** It exists to stop the model from smuggling data into URLs it writes. Server-issued redirects legitimately carry long tokens. The SSRF checks and the domain blocklist still run on every hop.
