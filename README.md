# Sol Neptune Gremlin MCP

This repository implements the `sol-neptune-gremlin` version `2.3.0` tool surface. `search_gremlin` retrieves one complete typed meta-graph in compact v1 by default, with `format="graphson"` for original GraphSON 3. Compact responses contain their literal dictionary and decoding grammar, preserving the full result directly in context. `get_current_time` returns a fresh server-clock sample. The seven existing tools remain available, including deprecated `read_gremlin` compatibility reads and guarded typed semantic persistence through the same endpoint and authenticated connection. Source implementation does not imply production deployment.

Neon is not read, written, migrated, synchronized, or reconfigured by this project. Neptune is not declared authoritative.

## What is implemented

```text
ChatGPT
   |
   | HTTPS /mcp + Streamable HTTP + OAuth bearer token
   v
Public MCP Lambda Function URL (not in the VPC)
   |
   | IAM-authorized Lambda Invoke, maxAttempts=1
   v
Private executor Lambda (two isolated VPC subnets)
   |
   | HTTPS :8182 + IAM database authentication, maxAttempts=1
   v
One encrypted db.t4g.medium Neptune writer; zero readers
```

The front Lambda uses the official TypeScript MCP SDK's Web-standard Streamable HTTP transport in stateless JSON-response mode. It permits anonymous initialization and tool discovery, but validates OAuth signature, issuer, expiry/not-before, exact audience/resource, `graph:execute` scope, and Robyn's configured immutable provider subject before invocation. `get_profile` returns only a deterministic opaque identifier and a generic display label; it does not reveal the provider subject, email address, or token. The private executor uses `@aws-sdk/client-neptunedata`, untyped GraphSON v3, the writer endpoint, and the Lambda role's temporary AWS credentials.

There is no NAT Gateway, Internet Gateway, public subnet, public Neptune instance, load balancer, API Gateway, EC2 instance, Fargate task, custom domain, or always-on MCP compute.

## Tool safety boundary

The public MCP Lambda classifies each submitted Gremlin-Groovy traversal before invoking the private executor:

- `search_gremlin` accepts read-only seed and blacklist queries; its private execution path independently validates those queries and every generated traversal.
- `read_gremlin` accepts only traversals classified as read-only.
- `write_gremlin` requires a recognized add/update step (`addV`, `addE`, `mergeV`, `mergeE`, or `property`) and rejects `drop`.
- `delete_gremlin` requires a recognized `drop` removal step.

The classifier is deliberately deny-by-default. It tokenizes the full traversal, including nested anonymous traversals, while ignoring quoted string contents and comments. It rejects unknown calls and dynamic Groovy features such as statements, assignments, closures, interpolated method names, bracket dispatch, reflection-style invocation, and unsupported syntax. This is a conservative traversal subset rather than a complete Gremlin-Groovy parser: a safe but unsupported query is rejected with `QUERY_INVALID` and must be reformulated or added to the allowlist with tests. A rejected traversal must never be moved to another tool merely to bypass the classifier.

The private executor, OAuth scope and subject checks, request IDs, result limits, and no-retry behavior are shared by the graph tools. All query strings, including generated semantic-commit queries, accept at most 262,144 UTF-8 bytes. In particular, an ambiguous invocation failure continues to return `UNKNOWN_MUTATION_OUTCOME` and the caller must not retry blindly.

## Neighborhood search and server time

`search_gremlin` takes `query`, optional `blacklist_query`, `depth` (minimum **0**, default **3**, maximum **7**), and `format` (**compact** by default, or **graphson**). It returns one complete typed meta-graph. Each meta-node contains a query-returnable typed value, g0 element, or explicit reference/fold descriptor; every meta-edge is one search hop. Ordinary node → edge → node, body references, and fold correspondences each cost two hops. Initial nodes retain every query position, preserving order and repeats. Blacklisted elements remain visible and never expand. `read_gremlin` remains available for compatibility; use `search_gremlin` at depth zero for new unexpanded reads. The full [wire contract](docs/search-gremlin.md) includes the compact grammar and native-snapshot token measurements. Callers parsing GraphSON directly must now specify `format="graphson"`.

Positive-depth searches compare the writer's Neptune stream head before and after all reads. A moving boundary returns `GRAPH_CHANGED`, without a mixed graph. The executor therefore needs the existing enabled Streams feature and cluster-scoped `neptune-db:GetStreamRecords`; the template adds only that read permission. Node/hop/query/time/response limits fail explicitly, without a partial graph. Ambiguous g0 folds are reported with `search.complete=false` and `search.unresolved_folds`, rather than inventing a mapping from prose.

`get_current_time` requires the same OAuth connection, takes no arguments, samples the server wall clock once per invocation, and returns `server_time_utc` and `unix_time_ms` for that same instant. It performs no graph I/O. [The API contract](docs/search-gremlin.md) defines identity, serialization, fold/reference interpretation, resource limits and error behavior.

## Typed semantic operations

`get_graph_state` returns the bounded canonical control-plane observation needed to prepare a write: Neptune authority and status, current semantic/graph/projection revisions, optional allocator cursors, and optional explicitly recorded v1 state. It validates that `sol:authority` names Neptune as the primary store and never infers v1 authority from the presence of v1 data.

`commit_semantic_delta` accepts a caller-resolved major-version-0 delta. It does not infer claims, provenance, relationships, supersession, or decision state. The server canonicalizes the request, permanently binds the operation ID to its SHA-256 payload identity, resolves temporary object references through the established `S`, `K`, `T`, `N`, and `H` allocator cursors, and stores a durable `operation:<operation_id>` receipt. Creates, bounded property replacements, explicit relationships, and explicit supersession edges are the only supported mutations; arbitrary Gremlin and every deletion primitive are absent from the schema.

Temporary references use the shared `$`-prefixed grammar `^\$[A-Za-z0-9_.:-]+$` everywhere they are accepted. A semantic create defaults to the canonical Neptune vertex label `Object`; its semantic `label`, `object_type`, and other semantic fields are vertex properties. An explicit `graph_label` overrides only the Neptune vertex label. Dedicated `source_refs` and `about_ref` fields and their generic `properties` aliases normalize to the same resolved vertex properties and deterministic `source` or `about` relationships. Conflicting alias forms are rejected before execution.

The fresh-write phase is emitted as one multi-statement Gremlin request. Neptune executes those statements in one transaction. Guard statements first lock and validate the authority epoch, the requested revision boundary, current allocator cursors, target nonexistence, update preconditions, and pre-existing relationship endpoints. Endpoints created by the same operation are validated by the canonical plan and materialized before their relationships. The transaction then reserves the receipt and allocation map, applies the bounded mutation, and advances only the requested revision domains and affected allocator cursors. A response is not reported as complete until separate readback validates the receipt, canonical v0 serialization, graph labels, semantic properties, edge IDs and endpoints, allocator advancement, and revision advancement.

`reconcile_operation` reloads the canonical request and allocation decisions from an existing receipt. It can idempotently continue missing non-destructive work, but it will not choose new IDs, reinterpret an operation ID, overwrite conflicting targets, perform cleanup deletion, or invent a replacement semantic request. Conflicting or destructively repairable state returns a stable structured error such as `OPERATION_ID_PAYLOAD_CONFLICT`, `RELATIONSHIP_CONFLICT`, `RECOVERY_NEEDED`, or `MANUAL_REPAIR_REQUIRED`.

The MCP URL, OAuth resource and connection identity are unchanged. Existing raw Gremlin schemas advertise the increased query-size limit. Refresh or rescan the connection's tool manifest after deploying to discover the new search and clock tools.

## Repository layout

- `src/mcp/` — public MCP resource server, OAuth validation, and private Lambda invocation.
- `src/mcp/gremlin-safety.ts` — conservative deny-by-default traversal classifier and tool-boundary enforcement.
- `src/mcp/semantic-contracts.ts` — strict typed-operation input contracts and public tool schemas.
- `src/mcp/semantic-operations.ts` — canonicalization, guarded state machine, Neptune transaction generation, exact verification, and deterministic reconciliation.
- `src/executor/` — VPC executor and Neptune Data API client.
- `src/executor/search.ts` — bounded breadth-first meta-graph construction, explicit correspondence/reference provenance and stream-head fencing.
- `src/shared/graphson.ts` — typed GraphSON identity and payload handling.
- `src/shared/` — response contracts and safe structured logging.
- `template.yaml` — dedicated SAM/CloudFormation stack.
- `test/` — protocol, OAuth, executor, logging, and infrastructure tests.
- `scripts/aws-preflight.sh` — read-only identity, Region, availability, resource, and cost check.
- `scripts/smoke-test.mjs` — initialization, nine-tool discovery, OAuth challenge, and optional authenticated graph state, profile, search and clock checks.
- `scripts/integration-test.mjs` — uniquely identified create/read/delete/deletion-verification test for Neptune only.

## Local prerequisites and verification

Use Node.js 24, npm, AWS SAM CLI, AWS CLI v2, and `jq`. Direct dependency versions and the lockfile are pinned.

```bash
npm ci
npm run check
sam validate --lint --template-file template.yaml
sam build --template-file template.yaml
```

`npm run check` runs deterministic formatting verification, lint, strict TypeScript checking, all unit/protocol tests, and both Lambda bundles. It does not contact AWS or execute Gremlin.

## Mandatory deployment gate

Possession of this repository does not authorize deployment, production changes, or AWS charges. Deployment requires Robyn's explicit instruction.

Before any mutating AWS command, run the read-only preflight with an explicitly expected account and Region:

```bash
./scripts/aws-preflight.sh us-east-1 EXPECTED_12_DIGIT_ACCOUNT_ID
```

It prints the account ID, caller ARN, selected Region, proposed resources, current default Neptune engine/family, `db.t4g.medium` availability, and the recurring-cost estimate. Stop if either the account or Region is unexpected, if the instance class is unavailable, or if the default engine/family does not support the required TinkerPop behavior. The template deliberately does not pin an engine release, so AWS selects the current supported default; `NeptuneParameterGroupFamily` must be set to its matching family.

Review the current official OpenAI MCP/Auth requirements and the current AWS Neptune/Lambda documentation again immediately before deployment. Stop on any protocol or security conflict.

## Cost estimate

The intended fixed recurring resource is the single Neptune writer. The `us-east-1` public price-file snapshot checked on 2026-09-21 showed:

- `db.t4g.medium`: `$0.093/hour`, approximately `$67.89` for 730 hours.
- Standard Neptune storage: `$0.10/GB-month`.
- Backup storage beyond the included allocation: `$0.021/GB-month`.
- Standard storage I/O: `$0.20` per million requests.
- Lambda invocations, CloudWatch Logs, snapshots, and data transfer are usage-dependent.

Pricing is not a quote and can change. Recheck the AWS pricing page/calculator before creating the stack. The stack creates no NAT Gateway or load balancer and no other resource expected to exceed `$5/month` on its own under this workload.

## Two-stage fail-closed deployment

The stack name is configurable; commands below use the approved default `sol-neptune-mcp`. Do not put OAuth tokens or provider secrets in `samconfig.toml`, shell history, source control, or CloudFormation parameters.

### Stage 1: infrastructure with MCP disabled

After explicit deployment authorization, build and create a change set without executing it:

```bash
sam build --template-file template.yaml
sam deploy \
  --stack-name sol-neptune-mcp \
  --region us-east-1 \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --confirm-changeset \
  --no-execute-changeset \
  --parameter-overrides \
    McpEnabled=false \
    NeptuneParameterGroupFamily=neptune1.4 \
    NeptuneDeletionProtection=false \
    LambdaReservedConcurrency=2
```

The omitted OAuth parameters use their fail-closed empty defaults in stage one; SAM rejects an empty `Key=` token in `--parameter-overrides`.

AWS requires at least 10 regional executions to remain unreserved. If the account's regional concurrency quota is only 10, set `LambdaReservedConcurrency=0`; the account-level quota then provides the aggregate technical limit. Do not request a quota increase solely to bypass this deployment check. Restore the specified per-function value of `2` only after the regional quota can accommodate both reservations while retaining 10 unreserved executions.

Inspect every change-set resource before execution. It must match the inventory in `scripts/aws-preflight.sh`; in particular it must contain one Neptune instance and none of the prohibited network or compute resources. Execute the reviewed change set only after Robyn approves it.

After stage 1 completes, obtain the stable URL:

```bash
aws cloudformation describe-stacks \
  --stack-name sol-neptune-mcp \
  --region us-east-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`CanonicalMcpUrl`].OutputValue' \
  --output text
```

The `/healthz` response is intentionally `ready: false`, and `/mcp` returns service unavailable. The executor has no Function URL and Neptune has no public route.

### Configure Auth0 or another approved established provider

Auth0 is preferred. Use an existing/free approved tenant; do not enable a paid plan without explicit approval. Configure:

1. An API/resource identifier exactly equal to the canonical MCP URL, including `/mcp` and without a trailing slash.
2. The `graph:execute` permission/scope.
3. Authorization code flow with PKCE S256.
4. Provider discovery metadata with the exact issuer, authorization and token endpoints, JWKS URI, an OpenAI-supported client-registration method (prefer CIMD; otherwise DCR or a preconfigured public client), and `S256` in `code_challenge_methods_supported`.
5. Tokens whose `aud` or `resource` is the exact canonical MCP URL.
6. Public signup disabled, or provider policy that cannot grant graph access to another user.
7. Robyn's immutable provider `sub` value as `AllowedSubject`; do not authorize by mutable email address.

When Auth0 uses Client ID Metadata Documents (CIMD), register every OpenAI
client metadata URI used by the intended surface. ChatGPT web uses
`https://chatgpt.com/oauth/client.json`, while Codex in the desktop app uses
`https://chatgpt.com/oauth/codex/client.json`. For each Auth0-generated client,
create a user-subject client grant for the canonical MCP audience with the
`graph:execute` scope. A default client-subject grant is for machine-to-machine
authorization and causes the interactive connection to fail even when the CIMD
client itself is registered correctly.

Auth0 treats these CIMD registrations as third-party applications and ignores
scopes that a Post Login Action tries to add to their access tokens. Do not use
an Action to force `graph:execute`. When a correctly signed and resource-bound
token lacks that scope, the MCP tool returns an OAuth challenge containing
`error="insufficient_scope"` and `scope="graph:execute"`; ChatGPT can then
reauthorize the account and request the missing permission explicitly.

No client secret is stored by either Lambda. If the selected provider requires a secret in Lambda or a paid feature, stop and obtain approval rather than improvising a storage service or a different identity design.

### Stage 2: enable OAuth-protected MCP

Create and review a second change set with the exact values:

```bash
sam deploy \
  --stack-name sol-neptune-mcp \
  --region us-east-1 \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --confirm-changeset \
  --no-execute-changeset \
  --parameter-overrides \
    McpEnabled=true \
    CanonicalMcpUrl="$MCP_URL" \
    OAuthIssuer="$OAUTH_ISSUER" \
    AllowedSubject="$ROBYN_OAUTH_SUBJECT" \
    NeptuneParameterGroupFamily="$NEPTUNE_PARAMETER_GROUP_FAMILY" \
    NeptuneDeletionProtection=false \
    LambdaReservedConcurrency="$LAMBDA_RESERVED_CONCURRENCY"
```

Execute only the reviewed change set. Then verify protected-resource metadata, OAuth provider discovery, and rejection of unauthenticated execution before any mutation.

## Deployment validation

### Static stack and network checks

Run and retain the output:

```bash
aws cloudformation describe-stack-resources \
  --stack-name sol-neptune-mcp \
  --region us-east-1

aws ec2 describe-route-tables \
  --region us-east-1 \
  --filters "Name=vpc-id,Values=$VPC_ID"

aws ec2 describe-security-groups \
  --region us-east-1 \
  --group-ids "$EXECUTOR_SECURITY_GROUP_ID" "$NEPTUNE_SECURITY_GROUP_ID"

aws lambda get-function-url-config \
  --region us-east-1 \
  --function-name "$MCP_FUNCTION_NAME"

# This must return ResourceNotFoundException:
aws lambda get-function-url-config \
  --region us-east-1 \
  --function-name "$EXECUTOR_FUNCTION_NAME"
```

Confirm that both route tables contain only their VPC-local route, Neptune ingress is only TCP 8182 from the executor security group, and there are no Internet/NAT gateways. Confirm the executor Lambda resource policy is absent and that this stack grants `lambda:InvokeFunction` only to the MCP role.

### MCP protocol and OAuth

```bash
MCP_URL="$MCP_URL" node scripts/smoke-test.mjs

npx @modelcontextprotocol/inspector@latest
```

In MCP Inspector, choose Streamable HTTP and enter the exact URL ending in `/mcp`. Verify initialize, initialized notification, `tools/list`, the OAuth challenge, authenticated linking, and the bounded read. Initialization and discovery are anonymous; `tools/call` is not.

To include the authenticated read in the non-interactive smoke test without printing the token:

```bash
read -rsp 'Short-lived MCP access token: ' MCP_ACCESS_TOKEN
export MCP_ACCESS_TOKEN MCP_URL
node scripts/smoke-test.mjs
unset MCP_ACCESS_TOKEN
```

### Controlled Neptune-only mutation

Run only after authenticated reads pass and only against this new Neptune cluster:

```bash
node scripts/integration-test.mjs
```

The script creates a uniquely named `SolMcpIntegrationTest` vertex, reads exactly that vertex, deletes it, and verifies a zero count. It prints the unique test ID. If it reports `UNKNOWN_MUTATION_OUTCOME`, do not rerun the mutation blindly; use that ID in a bounded read to determine whether the vertex exists, then delete only that vertex.

Never run this mutation against Neon.

### Enable deletion protection after integration

After all integration checks pass, create, review, and execute one final stack update with `NeptuneDeletionProtection=true`. Do not mark deployment complete until this is confirmed by `describe-db-clusters`.

### ChatGPT developer mode

This repository includes the portable ChatGPT/Codex plugin package at
`plugins/sol-neptune-graph`. The package contains its plugin manifest, direct
Streamable HTTP MCP configuration, OpenAI compatibility manifest, and a safety
skill for bounded Gremlin work. The repo marketplace is
`.agents/plugins/marketplace.json`.

For local ChatGPT testing:

1. Enable ChatGPT Developer mode.
2. In ChatGPT Plugins, create a connection named `Sol Neptune Graph` with the
   public MCP URL including `/mcp` and complete OAuth as Robyn.
3. Record the connection's non-secret technical ID from the browser URL and map
   it in `plugins/sol-neptune-graph/.app.json`.
4. Install or refresh `sol-neptune-graph@sol-neptune-local` from the repo
   marketplace, then start a new chat with the plugin enabled.
5. Confirm the three graph tools and their exact annotations: read-only and
   non-destructive for `read_gremlin`, non-read-only and non-destructive for
   `write_gremlin`, and non-read-only and destructive for `delete_gremlin`.
   Confirm the unchanged read-only `get_profile` identity utility and run one
   bounded read. Record the outcome.

Do not claim ChatGPT compatibility from Inspector or endpoint tests alone. See
`plugins/sol-neptune-graph/README.md` for package-specific validation and
installation details.

## Error and retry contract

Stable tool error codes are:

- `AUTH_REQUIRED`
- `AUTH_INVALID`
- `QUERY_INVALID`
- `QUERY_TIMEOUT`
- `RESULT_TOO_LARGE`
- `NEPTUNE_UNAVAILABLE`
- `UNKNOWN_MUTATION_OUTCOME`
- `INTERNAL_ERROR`

Every execution result is marked `retry_safe: false`. Neither the MCP-to-executor invocation nor the Neptune query is retried by the AWS SDK. A connection-level failure clears the cached Neptune client for the next invocation but does not retry the query whose outcome is unknown. Use idempotent Gremlin upserts with stable identifiers when practical.

The maximum query is 65,536 UTF-8 bytes. The structured result envelope is limited to 1 MiB. If execution completed but serialization exceeds the result limit, the result is omitted and `execution_completed: true` is returned so callers do not repeat a possible mutation merely to recover output.

## Logging and monitoring

Application logs contain only request IDs, Lambda request IDs, timings, byte counts, status categories, and sanitized exception class names. Gremlin text, graph results, bearer tokens, authorization headers, AWS credentials, subnet details, and raw exception messages are never intentionally logged. Neptune audit and slow-query exports are not enabled because they could capture query content.

Inspect the two 14-day log groups:

```bash
aws logs tail "/aws/lambda/$MCP_FUNCTION_NAME" \
  --region us-east-1 --since 1h --follow

aws logs tail "/aws/lambda/$EXECUTOR_FUNCTION_NAME" \
  --region us-east-1 --since 1h --follow
```

Use native Lambda metrics (`Errors`, `Duration`, `Throttles`, `ConcurrentExecutions`) and Neptune metrics such as CPU utilization and request-queue depth. Do not enable query-content logging to troubleshoot.

## Safe rollback

The first response to a problem is a fail-closed configuration update with `McpEnabled=false`. This leaves Neptune and its data intact while `/mcp` becomes unavailable.

For an application rollback, redeploy a previously tested source revision through a reviewed change set. Do not replace the Neptune cluster or change its identifier as part of an application rollback.

The current SAM template does not create Lambda aliases or publish immutable versions, and the Function URL targets the unqualified MCP function. Therefore a published version alone cannot redirect the existing URL. Before updating production, retain the current Lambda deployment package and its `CodeSha256`, plus the current CloudFormation template and parameters. The preferred rollback is a reviewed SAM/CloudFormation deployment of the retained prior source revision. A direct `update-function-code` using the retained package is emergency-only because it creates CloudFormation drift; follow it with a reviewed stack reconciliation.

Full stack deletion is destructive and is not a routine rollback. Deletion protection intentionally blocks it after integration, and the cluster has `DeletionPolicy: Snapshot` plus `UpdateReplacePolicy: Snapshot`. If Robyn explicitly authorizes decommissioning:

1. Disable MCP.
2. Confirm no execution is in flight.
3. Create and verify a named manual cluster snapshot.
4. Review a change set that disables deletion protection.
5. Only then delete the stack and verify the retained final snapshot.

Never delete the final or manual snapshots without separate explicit approval.

## Future conversion to Neptune Serverless

The MCP contract, OAuth resource, executor code, and cluster writer endpoint do not change. Following the current Neptune conversion procedure, add a `ServerlessScalingConfiguration`, create a `db.serverless` instance, wait for availability, fail over the cluster writer to it, and remove the provisioned writer only after verification. Perform that as a separately approved infrastructure change with a snapshot and reviewed change set.

## Normative references

- [OpenAI: Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [OpenAI: MCP authentication](https://developers.openai.com/plugins/build/auth)
- [OpenAI: Connect and test a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [AWS: Lambda Function URLs](https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html)
- [AWS: Securing Neptune with a VPC](https://docs.aws.amazon.com/neptune/latest/userguide/security-vpc.html)
- [AWS: Running Gremlin through the AWS SDK](https://docs.aws.amazon.com/neptune/latest/userguide/access-graph-gremlin-sdk.html)
- [AWS: Gremlin transactions in Neptune](https://docs.aws.amazon.com/neptune/latest/userguide/access-graph-gremlin-transactions.html)
- [AWS: Gremlin standards compliance in Neptune](https://docs.aws.amazon.com/neptune/latest/userguide/access-graph-gremlin-differences.html)
- [AWS: Native Gremlin step support](https://docs.aws.amazon.com/neptune/latest/userguide/gremlin-step-support.html)
- [Apache TinkerPop: Gremlin language reference](https://tinkerpop.apache.org/docs/current/reference/)
- [AWS: Converting a Neptune cluster to Serverless](https://docs.aws.amazon.com/neptune/latest/userguide/neptune-serverless-using.html)
