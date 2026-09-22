# Sol Neptune Gremlin MCP — Implementation and Deployment Requirements

**Status:** Approved design specification  
**Version:** 1.0  
**Date:** 2026-09-21  
**Intended implementer:** Codex  
**Owner:** Robyn Kirkman

## 1. Codex execution directive

Implement the system described here without expanding its scope. Prefer the smallest solution that satisfies every acceptance criterion. Do not substitute additional managed services, availability replicas, load balancers, NAT gateways, public Neptune access, custom domains, or paid identity products without Robyn's explicit approval.

Before making AWS changes, display the AWS account ID, caller identity, selected Region, resources to be created, and estimated recurring cost. Stop if the account or Region is ambiguous. Deployment requires an explicit instruction to deploy; possession of this document alone authorizes implementation and testing, not charges or production changes.

Never delete or modify unrelated AWS resources. Use a dedicated CloudFormation/SAM stack. Make the stack name configurable and default it to `sol-neptune-mcp`.

## 2. Purpose

Create a private Amazon Neptune graph and expose direct Gremlin execution to ChatGPT through a remotely hosted Model Context Protocol (MCP) server.

The design must provide:

- A single provisioned Neptune writer using `db.t4g.medium`.
- A stable, publicly reachable HTTPS MCP endpoint ending in `/mcp`.
- MCP Streamable HTTP compatibility with ChatGPT developer mode.
- One authenticated MCP tool that accepts arbitrary Gremlin and returns structured results.
- OAuth 2.1 user authentication.
- Private network isolation between the Internet and Neptune.
- No NAT Gateway, Application Load Balancer, API Gateway, public Neptune endpoint, or always-on MCP compute.
- A straightforward future conversion from the provisioned Neptune instance to Neptune Serverless without changing the MCP contract.

This is infrastructure for Sol's structural graph access. It is intentionally permissive after authentication: the service must not impose a semantic allowlist or attempt to decide what graph structures Sol may inspect or change.

## 3. Scope boundaries

### 3.1 In scope

- Infrastructure as code using AWS Serverless Application Model (SAM) and CloudFormation.
- A provisioned Neptune cluster with one writer.
- A public MCP-facing Lambda function with a Lambda Function URL.
- A separate private Neptune-executor Lambda function attached to the Neptune VPC.
- OAuth discovery, bearer-token validation, and authorization for the MCP tool.
- Direct execution of Gremlin through the Neptune Data API/HTTPS Gremlin endpoint.
- Automated tests, deployment instructions, smoke tests, and rollback instructions.
- CloudWatch logs and minimal operational metrics.

### 3.2 Explicitly out of scope

- Migrating data from Neon to Neptune.
- Changing, deleting, or ceasing use of the existing Neon graph.
- Declaring Neptune authoritative or performing a production cutover.
- Synchronization or dual writes between Neon and Neptune.
- Neptune readers, replicas, global databases, Serverless instances, or high-availability compute.
- An MCP user interface, MCP resources, prompts, or imported skills.
- Public plugin publication or marketplace submission.
- A custom domain, Route 53 zone, CloudFront distribution, API Gateway, load balancer, EC2 instance, Fargate task, or NAT Gateway.
- Building an OAuth authorization server from scratch.
- Supporting multiple end users or multiple graph tenants.

Until a separate migration and cutover is explicitly approved, Neon remains authoritative.

## 4. Normative references

Implementation must follow the current versions of these primary references at implementation time:

- [OpenAI: Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [OpenAI: MCP authentication](https://developers.openai.com/plugins/build/auth)
- [OpenAI: Connect and test a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [AWS: Lambda Function URLs](https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html)
- [AWS: Securing Neptune with a VPC](https://docs.aws.amazon.com/neptune/latest/userguide/security-vpc.html)
- [AWS: Accessing Neptune with Gremlin](https://docs.aws.amazon.com/neptune/latest/userguide/access-graph-gremlin.html)
- [AWS: Gremlin HTTPS REST endpoint](https://docs.aws.amazon.com/neptune/latest/userguide/access-graph-gremlin-rest.html)
- [AWS: Running Gremlin through the AWS SDK](https://docs.aws.amazon.com/neptune/latest/userguide/access-graph-gremlin-sdk.html)
- [AWS: Converting a Neptune cluster to Serverless](https://docs.aws.amazon.com/neptune/latest/userguide/neptune-serverless-using.html)

If current primary documentation conflicts with this specification on a protocol or security requirement, stop and report the conflict before changing the design.

## 5. Required architecture

```text
ChatGPT
   |
   | HTTPS + MCP Streamable HTTP + OAuth bearer token
   v
Public MCP Lambda Function URL
   |
   | IAM-authorized synchronous Lambda invocation
   v
Private executor Lambda in isolated VPC subnets
   |
   | HTTPS :8182 + IAM database authentication
   v
Amazon Neptune cluster: one db.t4g.medium writer
```

Two Lambda functions are required so the public MCP process can reach the OAuth provider's discovery/JWKS endpoints without a NAT Gateway while the executor remains privately connected to Neptune.

### 5.1 Public MCP Lambda

- Must not be attached to the VPC.
- Must expose a Lambda Function URL with AWS auth mode `NONE`; application-level OAuth is mandatory before tool execution.
- Must serve the MCP endpoint at `/mcp`.
- Must serve `/.well-known/oauth-protected-resource` without authentication.
- May serve `/healthz` without authentication. It must reveal only service name, version, and readiness state.
- Must implement MCP using the official TypeScript MCP SDK. Do not hand-roll JSON-RPC or the MCP state machine.
- Prefer the SDK's Web-standard Streamable HTTP transport if it works correctly in Lambda. If the current SDK cannot be adapted cleanly, use AWS Lambda Web Adapter with a minimal Node HTTP server. Do not switch to an always-on container.
- Must operate statelessly. Do not require sticky sessions or an external session store.
- Must invoke the executor Lambda synchronously through the AWS SDK and IAM.
- Must have no permission to access Neptune directly.

### 5.2 Private executor Lambda

- Must be attached to two isolated subnets in different Availability Zones.
- Must have no Function URL or other public invocation path.
- Its resource policy and execution role must allow invocation only from the MCP Lambda's role and authorized AWS service principals required by Lambda itself.
- Must call Neptune using `@aws-sdk/client-neptunedata` and `ExecuteGremlinQueryCommand`, pointed at the Neptune cluster endpoint.
- Must use the Lambda execution role's temporary credentials and Neptune IAM database authentication. No database password or static AWS key is permitted.
- Must set AWS SDK `maxAttempts` to `1`. Arbitrary Gremlin may mutate data, so transparent retries could duplicate writes.
- Must use untyped GraphSON v3 unless a current Neptune compatibility constraint requires another serializer.
- Must rebuild its Neptune client for the next invocation after a connection-level failure. It must not retry the query whose outcome is unknown.

### 5.3 Network

- Create a dedicated VPC unless deployment parameters explicitly identify an approved existing VPC and two approved isolated subnets.
- A newly created VPC must contain exactly two isolated subnets in separate Availability Zones for this stack.
- Do not create an Internet Gateway, NAT Gateway, public subnet, bastion host, or public Neptune endpoint.
- Neptune's security group must allow inbound TCP 8182 only from the executor Lambda's security group.
- The executor security group must allow the DNS traffic required for VPC name resolution and TCP 8182 to Neptune. Avoid unrestricted outbound access when CloudFormation can express the required rules reliably.

## 6. Neptune requirements

- Engine: Amazon Neptune, using a currently supported engine release compatible with TinkerPop 3.7 where available. Do not pin an obsolete engine version.
- Instance class: `db.t4g.medium`.
- Instances: exactly one writer and zero readers.
- Region: default `us-east-1`; make Region a deployment choice rather than hard-coding it in application logic.
- Port: 8182.
- IAM database authentication: enabled.
- Public endpoint: disabled.
- Storage encryption: enabled using an AWS-managed key unless Robyn supplies a customer-managed key.
- Backup retention: seven days.
- Deletion protection: enabled for the cluster after successful integration testing.
- CloudFormation deletion behavior: retain or snapshot the cluster rather than silently destroying graph data.
- Automatic minor-version upgrades: enabled when supported.
- Query timeout: target 10 seconds through a cluster parameter group. If the supported parameter has a different unit or allowable minimum, document and use the closest safe value.
- The application must use the cluster writer endpoint, not the instance endpoint, so a later failover or conversion to Serverless requires no endpoint change.

The application must not make assumptions tied to `db.t4g.medium` beyond capacity. A future conversion to `db.serverless` should require infrastructure changes only.

## 7. MCP server contract

### 7.1 Server identity

- Stable server name: `sol-neptune-gremlin`.
- Semantic version starting at `1.0.0`.
- Server instructions must say, concisely, that the server exposes Sol's private structural graph through Gremlin; callers should bound potentially large traversals; operations may mutate data; and unknown mutation outcomes must not be retried blindly.

### 7.2 Transport

- Use MCP Streamable HTTP at the exact public URL `<function-url>/mcp`.
- Support MCP initialization, initialized notification handling, `tools/list`, `tools/call`, and protocol-level errors required by the negotiated MCP version.
- Initialization and tool discovery may be anonymous so ChatGPT can inspect the server.
- Tool execution must require a valid OAuth access token.
- The deployed endpoint must pass MCP Inspector using Streamable HTTP and connect successfully in ChatGPT developer mode.
- Streaming Server-Sent Events are not required if the current MCP SDK and ChatGPT accept a valid Streamable HTTP JSON response for the request. If current conformance testing requires streamed responses, enable Lambda response streaming rather than changing hosting platforms.

### 7.3 Tool

Expose exactly one graph tool in version 1:

`execute_gremlin`

Input schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["query"],
  "properties": {
    "query": {
      "type": "string",
      "minLength": 1,
      "maxLength": 65536,
      "description": "A Gremlin query or mutation to execute against Sol's Neptune graph."
    }
  }
}
```

The server must not parse, rewrite, normalize, or semantically restrict the Gremlin query. In particular, it must permit reads, inserts, updates, edge and vertex creation, property changes, and deletions. Technical limits on request size, duration, concurrency, and response size are required and are not semantic authorization restrictions.

Tool annotations must be accurate:

- `readOnlyHint: false`
- `destructiveHint: true`
- `openWorldHint: false`

Declare an OAuth security scheme requiring scope `graph:execute`. Do not add a second confirmation mechanism inside the server. ChatGPT's permission layer may be configured by Robyn to allow this tool without repeated confirmations, but the server must not falsify its annotations to obtain that behavior.

### 7.4 Success result

Return both model-readable content and structured content. The structured result must have this conceptual form:

```json
{
  "ok": true,
  "result": {},
  "meta": {
    "request_id": "opaque-id",
    "elapsed_ms": 123,
    "result_bytes": 456,
    "retry_safe": false
  }
}
```

`result` may be any JSON-compatible value returned by untyped GraphSON. Do not coerce graph identifiers or property values beyond what the serializer requires.

### 7.5 Errors and unknown outcomes

Return stable machine-readable error codes, a concise message, an opaque request ID, and whether retry is safe. At minimum distinguish:

- `AUTH_REQUIRED`
- `AUTH_INVALID`
- `QUERY_INVALID`
- `QUERY_TIMEOUT`
- `RESULT_TOO_LARGE`
- `NEPTUNE_UNAVAILABLE`
- `UNKNOWN_MUTATION_OUTCOME`
- `INTERNAL_ERROR`

Never expose OAuth tokens, AWS credentials, internal stack identifiers, private subnet information, or raw exception dumps.

If the client loses the response after a query may have reached Neptune, return `UNKNOWN_MUTATION_OUTCOME` with `retry_safe: false`. Do not retry automatically. Documentation must recommend idempotent Gremlin upserts when practical.

## 8. Authentication and authorization

This graph is private and the tool can mutate it. An unauthenticated public tool endpoint is prohibited.

### 8.1 Identity provider

- Use an established OAuth 2.1/OIDC identity provider compatible with the current MCP authorization specification.
- Prefer Auth0 because the current official OpenAI documentation provides an MCP-specific integration path.
- Do not implement an authorization server from scratch.
- Do not purchase or enable a paid identity plan without explicit approval.
- Do not substitute Amazon Cognito unless its current behavior is first proven to satisfy MCP protected-resource discovery, authorization-code flow with PKCE S256, the chosen ChatGPT client-registration method, and resource/audience binding.

### 8.2 Required OAuth behavior

- Authorization-code flow with PKCE S256.
- Protected resource metadata at `/.well-known/oauth-protected-resource`.
- Exact HTTPS resource identifier equal to the canonical MCP URL, including consistent trailing-slash handling.
- OAuth discovery metadata published by the provider.
- Access tokens bound to the MCP resource through `aud` or `resource`.
- Required scope: `graph:execute`.
- Token validation on every tool call: signature, issuer, audience/resource, expiry/not-before, scope, and allowed subject.
- Only Robyn's configured immutable provider subject may execute the tool. Public signup must be disabled or otherwise prevented from granting graph access.
- Missing or invalid authorization must yield the MCP/OAuth `WWW-Authenticate` challenge and `_meta["mcp/www_authenticate"]` behavior required by current OpenAI documentation.

ChatGPT cannot present a custom API key. Do not treat the entropy of the Lambda URL as authentication.

### 8.3 Deployment bootstrap

OAuth configuration depends on the stable Lambda URL. Use a fail-closed two-stage deployment:

1. Deploy infrastructure with `McpEnabled=false`. The public Lambda may answer `/healthz`, but `/mcp` tool execution must return service unavailable and the executor must remain unreachable from the Internet.
2. Report the exact canonical MCP URL.
3. Configure the approved identity provider for that resource and obtain the issuer, audience/resource, allowed subject, and any ChatGPT client-registration settings.
4. Update the stack with OAuth configuration and `McpEnabled=true`.
5. Verify discovery metadata and authentication before executing any Gremlin mutation.

No secret or provider credential may be committed to source control. Prefer public-client/CIMD or another provider-supported method that does not require a client secret in Lambda. If a secret is unavoidable, stop and obtain approval for its storage mechanism and any recurring cost.

## 9. Resource limits and cost controls

- Maximum Gremlin query length: 65,536 UTF-8 bytes.
- Maximum structured result returned to ChatGPT: 1 MiB after JSON serialization.
- If a larger result has already executed, return metadata stating that execution completed but the result was omitted; do not invite blind retry of a possible mutation.
- Neptune server-side query timeout target: 10 seconds.
- Executor Lambda timeout: 15 seconds.
- MCP Lambda timeout: 25 seconds.
- Executor Lambda memory: begin at 512 MiB.
- MCP Lambda memory: begin at 512 MiB.
- Reserved concurrency: begin at 2 for each Lambda unless testing proves that a different value is necessary.
- AWS SDK retries for Gremlin execution: disabled (`maxAttempts: 1`).
- CloudWatch log retention: 14 days.
- Never log Gremlin query text, query results, bearer tokens, authorization headers, or graph content. Log request ID, timings, result byte count, status category, Lambda request ID, and sanitized error class only.

The intended recurring architecture cost is the single Neptune medium instance plus storage/backups and negligible request-driven Lambda/log charges. No additional resource expected to cost more than $5/month may be created without explicit approval. In particular, a NAT Gateway or load balancer is prohibited.

## 10. IAM requirements

Use least-privilege roles generated by the stack.

### MCP Lambda role

- Write its own CloudWatch logs.
- Invoke only the specific executor Lambda.
- No Neptune permissions.
- No permission to enumerate or mutate unrelated Lambda functions, VPC resources, or CloudFormation stacks.

### Executor Lambda role

- Write its own CloudWatch logs.
- Permit only the Neptune data-plane actions needed to read, write, and delete graph data through queries against this cluster.
- Scope Neptune permissions to this cluster's resource ARN wherever CloudFormation supports it.
- No permission to create, modify, snapshot, or delete Neptune infrastructure.

Do not use `AdministratorAccess`, `PowerUserAccess`, wildcard service permissions, static access keys, or credentials stored in environment variables.

## 11. Implementation requirements

- Language/runtime: TypeScript on a currently supported AWS Lambda Node.js runtime.
- Pin direct dependency versions and commit the lockfile.
- Use the official TypeScript MCP SDK and AWS SDK v3.
- Validate all external input with an explicit schema.
- Keep the front Lambda, executor Lambda, and infrastructure definitions in separable modules.
- Keep generated build output, local environment files, SAM artifacts, tokens, and credentials out of version control.
- Include deterministic formatting, linting, type checking, and tests runnable with one documented command.
- Do not add an application framework unless required for correct Streamable HTTP transport. If one is needed, choose a small, maintained framework and document why.

Expected repository contents:

```text
README.md
template.yaml
package.json
package-lock.json
tsconfig.json
src/mcp/
src/executor/
test/
scripts/smoke-test.*
samconfig.toml.example
.gitignore
```

## 12. Tests

### 12.1 Automated tests

At minimum, test:

- MCP initialization and `tools/list`.
- Exact tool name, schema, OAuth scheme, and annotations.
- Query size validation.
- Missing token rejection.
- Invalid signature, issuer, audience/resource, expiry, scope, and subject rejection.
- Valid token acceptance.
- The MCP Lambda cannot call Neptune directly.
- The executor rejects unauthorized invocation paths where testable.
- Successful read query mapping.
- Successful mutation result mapping.
- Invalid Gremlin mapping.
- Neptune timeout mapping.
- Result-size handling.
- Unknown mutation outcome is marked not retry-safe.
- The Neptune SDK client is configured with one attempt.
- Query and result content do not appear in logs produced by tests.

Use mocks for unit tests. Do not weaken production authentication to simplify testing.

### 12.2 Deployment validation

Run and record:

- Formatting, lint, type check, and unit tests.
- `sam validate --lint`.
- `sam build`.
- A CloudFormation change-set review before deployment.
- Security-group and route-table inspection proving there is no public path to Neptune and no NAT Gateway.
- Verification that the executor has no Function URL.
- Verification that unauthenticated `tools/call` cannot invoke Gremlin.
- MCP Inspector initialization, tool discovery, authentication challenge, and an authenticated read call.
- A controlled integration mutation that creates a uniquely named temporary vertex, reads it, deletes it, and verifies deletion.
- ChatGPT developer-mode connection and one bounded read call.

Do not run the mutation test against Neon. Clean up only the uniquely identified temporary Neptune test vertex.

## 13. Acceptance criteria

The work is complete only when all of the following are true:

1. The stack contains one `db.t4g.medium` Neptune writer and no reader.
2. Neptune is private, encrypted, IAM-authenticated, and reachable only from the executor security group on port 8182.
3. There is no NAT Gateway, load balancer, API Gateway, EC2 instance, Fargate task, or public Neptune endpoint.
4. The MCP URL is stable HTTPS and ends in `/mcp`.
5. The endpoint passes MCP Inspector as Streamable HTTP.
6. ChatGPT developer mode can discover `execute_gremlin`.
7. Tool execution requires valid OAuth and the `graph:execute` scope.
8. Tokens for any subject other than Robyn's configured subject are rejected.
9. Authenticated Gremlin reads and mutations succeed.
10. Gremlin execution has no automatic retries.
11. Oversized, timed-out, invalid, and unknown-outcome operations produce stable structured errors.
12. Query text, graph data, and credentials are absent from logs.
13. The test suite and SAM validation pass.
14. The README documents deployment, OAuth setup, testing, monitoring, estimated recurring resources, rollback, and future conversion to Neptune Serverless.
15. Neon has not been modified and no migration or authority cutover has occurred.

## 14. Required handoff

At completion, Codex must provide:

- A concise summary of what was built.
- The repository path and commit identifier, if a repository is used.
- The CloudFormation stack name, AWS account ID, and Region.
- The canonical MCP URL.
- The Neptune cluster identifier, engine version, and instance class.
- The identity provider issuer and resource/audience identifiers, excluding secrets.
- Commands for test, build, deployment update, log inspection, and rollback.
- The final CloudFormation change-set/resource summary.
- A list of all recurring-cost AWS resources.
- Test evidence for every acceptance criterion.
- Any deviations from this specification, each explicitly approved by Robyn.

## 15. Stop conditions

Stop and ask Robyn rather than improvising if:

- AWS credentials point to an unexpected account or Region.
- An existing resource would be modified or deleted.
- The selected identity provider cannot satisfy current MCP OAuth requirements.
- ChatGPT requires a transport behavior that Lambda Function URLs cannot provide correctly.
- Correct implementation would require a NAT Gateway, load balancer, API Gateway, custom domain, paid identity plan, or other recurring service not listed here.
- Neptune does not offer `db.t4g.medium` with the required engine in the selected Region.
- Any action would modify Neon, migrate data, or declare Neptune authoritative.
- A destructive rollback would remove graph data or snapshots.

Do not silently relax security, authentication, durability, cost, or protocol requirements to continue.
