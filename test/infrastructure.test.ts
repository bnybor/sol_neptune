import { readFile } from "node:fs/promises";

describe("SAM/CloudFormation architecture", () => {
  let template: string;

  beforeAll(async () => {
    template = await readFile(
      new URL("../template.yaml", import.meta.url),
      "utf8",
    );
  });

  it("declares exactly one db.t4g.medium Neptune instance", () => {
    expect(template.match(/Type: AWS::Neptune::DBInstance/g)).toHaveLength(1);
    expect(template).toContain("DBInstanceClass: db.t4g.medium");
    expect(template).toContain("PubliclyAccessible: false");
    expect(template).toContain("IamAuthEnabled: true");
    expect(template).toContain("StorageEncrypted: true");
  });

  it("contains no prohibited public-network or always-on compute resources", () => {
    for (const prohibited of [
      "AWS::EC2::NatGateway",
      "AWS::EC2::InternetGateway",
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
      "AWS::ApiGateway::",
      "AWS::ApiGatewayV2::",
      "AWS::EC2::Instance",
      "AWS::ECS::Service",
    ]) {
      expect(template).not.toContain(prohibited);
    }
    expect(template.match(/^ {4}Type: AWS::EC2::Subnet$/gm)).toHaveLength(2);
  });

  it("gives the MCP role only executor invocation and no Neptune data permission", () => {
    const mcpSection = template.slice(
      template.indexOf("  McpFunction:\n"),
      template.indexOf("  McpFunctionUrl:\n"),
    );
    expect(mcpSection).toContain("Action: lambda:InvokeFunction");
    expect(mcpSection).not.toContain("neptune-db:");
    expect(mcpSection).not.toContain("VpcConfig:");
  });

  it("has no public invocation resource for the executor", () => {
    expect(template).toContain("TargetFunctionArn: !GetAtt McpFunction.Arn");
    expect(template).not.toContain(
      "TargetFunctionArn: !GetAtt ExecutorFunction.Arn",
    );
  });

  it("retains or snapshots graph data and uses a ten-second query timeout", () => {
    expect(template).toMatch(
      /NeptuneCluster:\n[\s\S]*?DeletionPolicy: Snapshot/,
    );
    expect(template).toContain('neptune_query_timeout: "10000"');
    expect(template).toContain("BackupRetentionPeriod: 7");
  });

  it("can omit per-function reservations when the regional quota is only ten", () => {
    expect(template).toMatch(
      /LambdaReservedConcurrency:\n\s+Type: Number\n\s+Default: 2\n\s+MinValue: 0/,
    );
    expect(template).toMatch(
      /UseLambdaReservedConcurrency:\n\s+!Not \[!Equals \[!Ref LambdaReservedConcurrency, 0\]\]/,
    );
    expect(template.match(/ReservedConcurrentExecutions: !If/g)).toHaveLength(
      2,
    );
  });

  it("does not import the Neptune SDK anywhere in the public MCP source", async () => {
    const sourceFiles = [
      "auth.ts",
      "config.ts",
      "executor-invoker.ts",
      "handler.ts",
      "server.ts",
    ];
    for (const file of sourceFiles) {
      const source = await readFile(
        new URL(`../src/mcp/${file}`, import.meta.url),
        "utf8",
      );
      expect(source).not.toContain("client-neptunedata");
    }
  });
});
