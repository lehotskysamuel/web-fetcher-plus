/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "aikiddo-mcp",
      removal: input?.stage === "prod" ? "retain" : "remove",
      protect: ["prod"].includes(input?.stage),
      home: "aws",
      providers: {
        aws: {
          region: "eu-west-1",
          // Sandbox account. Deploys fail if your credentials point at any other account.
          allowedAccountIds: ["469819851476"],
        },
      },
    };
  },
  async run() {
    // Parameters are created by hand (see README), never by SST. Each stage has its own.
    const ssmPrefix = `/aikiddo-mcp/${$app.stage}/`;
    const { accountId } = await aws.getCallerIdentity({});
    const { region } = await aws.getRegion({});
    // The AWS managed key SSM uses for SecureString. It exists once the first SecureString is created.
    const ssmKey = await aws.kms.getAlias({ name: "alias/aws/ssm" });

    const mcp = new sst.aws.Function("Mcp", {
      handler: "src/handler.handler",
      runtime: "nodejs24.x",
      memory: "1024 MB",
      timeout: "75 seconds", // Two Unlocker attempts of 35 s (ATTEMPT_MS in src/fetch/unlocker.ts) plus 5 s of our own work.
      url: true,
      environment: {
        SSM_PREFIX: ssmPrefix,
        // Comma-separated; unset means the default list in src/fetch/safety.ts.
        ...(process.env.BLOCKED_DOMAINS !== undefined && {
          BLOCKED_DOMAINS: process.env.BLOCKED_DOMAINS,
        }), // TODO Saam - remove blocked domains
      },
      permissions: [
        {
          actions: ["ssm:GetParameter", "ssm:GetParameters"],
          resources: [
            `arn:aws:ssm:${region}:${accountId}:parameter${ssmPrefix}*`,
          ],
        },
        { actions: ["kms:Decrypt"], resources: [ssmKey.targetKeyArn] },
      ],
    });

    return {
      url: mcp.url,
    };
  },
});
