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
    const mcp = new sst.aws.Function("Mcp", {
      handler: "src/handler.handler",
      runtime: "nodejs24.x",
      memory: "512 MB",
      timeout: "30 seconds",
      url: true,
    });

    return {
      url: mcp.url,
    };
  },
});
