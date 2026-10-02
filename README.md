# aikiddo-mcp

A custom connector for claude.ai: a remote MCP server on AWS Lambda, deployed with [SST](https://sst.dev). You deploy it to your own AWS account and add it to claude.ai by URL.

The server will host several tools; web fetching (`fetch_page`) is the first planned one. Current state: hello world. One tool, `hello`, proves the chain SST → Lambda Function URL → MCP → claude.ai works. **There is no auth yet; the endpoint is public.**

## Prerequisites

- Node.js 20 or newer, and npm.
- AWS credentials for the account you deploy to. Any method the AWS SDK understands works, for example `aws sso login --profile <name>` followed by `export AWS_PROFILE=<name>`.
- The app deploys to `eu-west-1` (Ireland), to the sandbox account `469819851476` only. Both are set under `providers.aws` in `sst.config.ts`: `allowedAccountIds` makes a deploy with credentials for any other account fail before it changes anything. To deploy to your own account, change that ID.

## Deploy

```bash
npm install
npx sst deploy --stage prod
```

The deploy prints the Function URL as `url`, for example `https://abc123.lambda-url.eu-west-1.on.aws/`.

Check it:

```bash
curl https://<url>/healthz
```

The stage `prod` is protected and its resources are retained, so `sst remove --stage prod` will not delete it by accident. For experiments, use another stage, then clean it up:

```bash
npx sst deploy --stage dev
npx sst remove --stage dev
```

## Endpoints

| Path       | Method | Response                                                 |
| ---------- | ------ | -------------------------------------------------------- |
| `/mcp`     | POST   | MCP Streamable HTTP, stateless, JSON responses (no SSE)  |
| `/mcp`     | other  | `405`                                                    |
| `/healthz` | GET    | `200 ok`                                                 |
| anything else |     | `404`                                                    |

## Test with MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Choose transport **Streamable HTTP**, enter `https://<url>/mcp`, and connect. **Tools → List Tools** shows `hello`; run it to get the greeting.

## Add to claude.ai

1. Go to **Settings → Connectors → Add custom connector**. On Team and Enterprise plans, an owner adds it under **Organization settings → Connectors** first.
2. Name: `aikiddo-mcp`. URL: `https://<url>/mcp`. Leave the OAuth fields empty.
3. In a new chat, enable the connector from the tools menu and ask: "Use the hello tool with my name, Peter."

## Layout

- `sst.config.ts`: the Lambda function (Node 24, 512 MB, 30 s, public Function URL).
- `src/handler.ts`: routing, and the adapter between the Lambda Function URL event and the MCP SDK's web-standard transport.
- `src/tools/hello.ts`: the `hello` tool.

## Gotchas

- **The stage `prod` is not the production AWS account.** It is only the SST stage name. Every stage deploys to the account in `allowedAccountIds`, which is the sandbox account.
- **SST v4, not v3.** `npx sst@latest init` now installs SST v4. v4 only moves to the Pulumi AWS provider v7; SST components such as `sst.aws.Function` have the same API as in v3.
- **`sst init` prompts even with `--yes`.** It asks for the provider (aws or cloudflare) and needs a terminal to answer.
- **No Express adapter needed.** The MCP SDK ships `WebStandardStreamableHTTPServerTransport`, which maps a web `Request` to a `Response`. The handler converts the Function URL event to a `Request` and the `Response` back to the Lambda result. Bodies can arrive base64-encoded, so the handler decodes them.
- **Stateless means a new server per request.** The SDK rejects reusing a stateless transport across requests, so each invocation creates its own `McpServer` and transport.
- **GET `/mcp` returns 405.** In stateless JSON mode there is no standalone SSE stream, and the spec allows a server to return 405 for GET.
- **POST needs both Accept types.** The transport returns 406 unless `Accept` includes both `application/json` and `text/event-stream`. Inspector and claude.ai send both; plain `curl` tests have to set the header.
