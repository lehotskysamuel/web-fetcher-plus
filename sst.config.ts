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
    const reservedConcurrency = Number(process.env.RESERVED_CONCURRENCY ?? 5);

    const mcp = new sst.aws.Function("Mcp", {
      handler: "src/handler.handler",
      runtime: "nodejs24.x",
      memory: "1024 MB",
      // Room for a 15 s direct fetch plus an Unlocker call with one retry.
      timeout: "90 seconds",
      // Cost backstop: caps parallel (and so paid) Unlocker calls. AWS refuses a reservation that leaves
      // the account fewer than 10 unreserved executions, so accounts at the default limit of 10 set
      // RESERVED_CONCURRENCY=0 to skip it.
      concurrency: reservedConcurrency ? { reserved: reservedConcurrency } : undefined,
      url: true,
      environment: {
        SSM_PREFIX: ssmPrefix,
        // Comma-separated; unset means the default list in src/fetch/safety.ts.
        ...(process.env.BLOCKED_DOMAINS !== undefined && { BLOCKED_DOMAINS: process.env.BLOCKED_DOMAINS }),
      },
      permissions: [
        {
          actions: ["ssm:GetParameters"],
          resources: [`arn:aws:ssm:${region}:${accountId}:parameter${ssmPrefix}*`],
        },
        { actions: ["kms:Decrypt"], resources: [ssmKey.targetKeyArn] },
      ],
    });

    return {
      url: mcp.url,
    };
  },
});
