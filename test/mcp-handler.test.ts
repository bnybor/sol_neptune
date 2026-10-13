import type { ExecutionResponse } from "../src/shared/contracts.js";
import { MAX_QUERY_BYTES } from "../src/shared/contracts.js";
import { TokenValidationError } from "../src/mcp/auth.js";
import type { McpConfig } from "../src/mcp/config.js";
import { ExecutorInvocationError } from "../src/mcp/executor-invoker.js";
import { createHandler } from "../src/mcp/handler.js";
import {
  functionUrlEvent,
  jsonRpcRequest,
  parseResponseBody,
  TEST_HOST,
} from "./helpers.js";

const config: McpConfig = {
  enabled: true,
  executorFunctionName: "executor",
  canonicalMcpUrl: `https://${TEST_HOST}/mcp`,
  oauthIssuer: "https://issuer.example/",
  allowedSubject: "auth0|robyn",
  serviceVersion: "1.0.0",
};

const context = { awsRequestId: "lambda-request" };

function resultOf(body: Record<string, unknown>): Record<string, unknown> {
  return body.result as Record<string, unknown>;
}

describe("MCP Lambda handler", () => {
  it("initializes anonymously with the stable server identity and instructions", async () => {
    const handler = createHandler({ config });
    const response = await handler(
      functionUrlEvent("/mcp", {
        body: jsonRpcRequest("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "vitest", version: "1.0.0" },
        }),
      }),
      context,
    );
    const result = resultOf(parseResponseBody(response.body));

    expect(response.statusCode).toBe(200);
    expect(result.serverInfo).toEqual({
      name: "sol-neptune-gremlin",
      version: "1.0.0",
    });
    expect(result.instructions).toContain("unknown mutation outcome");
  });

  it("preserves the four existing tools and adds typed semantic operations", async () => {
    const handler = createHandler({ config });
    const response = await handler(
      functionUrlEvent("/mcp", { body: jsonRpcRequest("tools/list", {}) }),
      context,
    );
    const result = resultOf(parseResponseBody(response.body));
    const tools = result.tools as Record<string, unknown>[];

    expect(tools).toHaveLength(9);
    expect(tools.find((tool) => tool.name === "search_gremlin")).toMatchObject({
      inputSchema: {
        properties: {
          depth: { minimum: 0, default: 3, maximum: 7 },
          format: { enum: ["compact", "graphson"], default: "compact" },
          query: { maxLength: MAX_QUERY_BYTES },
          blacklist_query: { maxLength: MAX_QUERY_BYTES },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
    expect(
      tools.find((tool) => tool.name === "get_current_time"),
    ).toBeDefined();
    const readTool = tools.find((tool) => tool.name === "read_gremlin");
    const writeTool = tools.find((tool) => tool.name === "write_gremlin");
    const deleteTool = tools.find((tool) => tool.name === "delete_gremlin");
    const profileTool = tools.find((tool) => tool.name === "get_profile");
    const stateTool = tools.find((tool) => tool.name === "get_graph_state");
    const commitTool = tools.find(
      (tool) => tool.name === "commit_semantic_delta",
    );
    const reconcileTool = tools.find(
      (tool) => tool.name === "reconcile_operation",
    );
    expect(readTool?.description).toContain("cannot mutate the graph");
    expect(writeTool?.description).toContain("rejects removals");
    expect(deleteTool?.description).toContain(
      "remove vertices, edges, or properties",
    );
    expect(readTool).toMatchObject({
      name: "read_gremlin",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: MAX_QUERY_BYTES },
        },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      securitySchemes: [{ type: "oauth2", scopes: ["graph:execute"] }],
    });
    expect(writeTool).toMatchObject({
      name: "write_gremlin",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      securitySchemes: [{ type: "oauth2", scopes: ["graph:execute"] }],
    });
    expect(deleteTool).toMatchObject({
      name: "delete_gremlin",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
      securitySchemes: [{ type: "oauth2", scopes: ["graph:execute"] }],
    });
    expect(profileTool).toMatchObject({
      name: "get_profile",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      securitySchemes: [{ type: "oauth2", scopes: ["graph:execute"] }],
      _meta: { "openai/profile": true },
    });
    expect(stateTool).toMatchObject({
      name: "get_graph_state",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          include_allocators: { type: "boolean", default: true },
          include_v1_state: { type: "boolean", default: false },
        },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      securitySchemes: [{ type: "oauth2", scopes: ["graph:execute"] }],
    });
    expect(commitTool).toMatchObject({
      name: "commit_semantic_delta",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["operation_id", "authority_epoch", "expected", "origin"],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    expect(reconcileTool).toMatchObject({
      name: "reconcile_operation",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
  });

  it("routes typed semantic tools through the authenticated semantic service", async () => {
    const invokeExecutor = vi.fn();
    const semanticOperations = {
      getGraphState: vi.fn().mockResolvedValue({
        primary_store: "neptune",
        authority_epoch: "epoch-1",
        authority_status: "active",
        semantic_revision: 10,
        graph_revision: 10,
        projection_revision: 10,
        major_version: 0,
      }),
      commitSemanticDelta: vi.fn(),
      reconcileOperation: vi.fn(),
    };
    const handler = createHandler({
      config,
      invokeExecutor,
      semanticOperations,
      tokenVerifier: vi.fn().mockResolvedValue({ sub: config.allowedSubject }),
    });
    const response = await handler(
      functionUrlEvent("/mcp", {
        authorization: "Bearer valid-token",
        body: jsonRpcRequest("tools/call", {
          name: "get_graph_state",
          arguments: { include_allocators: false },
        }),
      }),
      context,
    );
    const result = resultOf(parseResponseBody(response.body));

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      primary_store: "neptune",
      semantic_revision: 10,
    });
    expect(semanticOperations.getGraphState).toHaveBeenCalledWith(
      { include_allocators: false, include_v1_state: false },
      expect.any(String),
    );
    expect(invokeExecutor).not.toHaveBeenCalled();
  });

  it("returns a stable opaque profile without invoking Neptune", async () => {
    const invokeExecutor = vi.fn();
    const handler = createHandler({
      config,
      invokeExecutor,
      tokenVerifier: vi.fn().mockResolvedValue({ sub: config.allowedSubject }),
    });
    const callProfile = () =>
      handler(
        functionUrlEvent("/mcp", {
          authorization: "Bearer valid-token",
          body: jsonRpcRequest("tools/call", {
            name: "get_profile",
            arguments: {},
          }),
        }),
        context,
      );

    const first = resultOf(parseResponseBody((await callProfile()).body));
    const second = resultOf(parseResponseBody((await callProfile()).body));
    const firstProfile = first.structuredContent as Record<string, unknown>;
    const secondProfile = second.structuredContent as Record<string, unknown>;

    expect(first.isError).toBe(false);
    expect(firstProfile.id).toEqual(secondProfile.id);
    expect(firstProfile.id).not.toBe(config.allowedSubject);
    expect(firstProfile.id).toMatch(/^sol_[A-Za-z0-9_-]+$/u);
    expect(firstProfile).toEqual({
      id: firstProfile.id,
      nickname: "Sol Neptune owner",
    });
    expect(invokeExecutor).not.toHaveBeenCalled();
  });

  it("rejects a missing token with both OAuth challenge mechanisms", async () => {
    const handler = createHandler({ config });
    const response = await handler(
      functionUrlEvent("/mcp", {
        body: jsonRpcRequest("tools/call", {
          name: "read_gremlin",
          arguments: { query: "g.V().limit(1)" },
        }),
      }),
      context,
    );
    const result = resultOf(parseResponseBody(response.body));
    const structured = result.structuredContent as Record<string, unknown>;
    const error = structured.error as Record<string, unknown>;
    const meta = result._meta as Record<string, unknown>;

    expect(error.code).toBe("AUTH_REQUIRED");
    expect(response.headers?.["www-authenticate"]).toContain(
      "resource_metadata=",
    );
    expect(meta["mcp/www_authenticate"]).toBeInstanceOf(Array);
  });

  it("rejects an invalid token without invoking the executor", async () => {
    const invokeExecutor = vi.fn();
    const handler = createHandler({
      config,
      invokeExecutor,
      tokenVerifier: vi.fn().mockRejectedValue(new Error("invalid")),
    });
    const response = await handler(
      functionUrlEvent("/mcp", {
        authorization: "Bearer invalid-token",
        body: jsonRpcRequest("tools/call", {
          name: "read_gremlin",
          arguments: { query: "g.V()" },
        }),
      }),
      context,
    );
    const result = resultOf(parseResponseBody(response.body));
    const structured = result.structuredContent as Record<string, unknown>;

    expect((structured.error as Record<string, unknown>).code).toBe(
      "AUTH_INVALID",
    );
    expect(invokeExecutor).not.toHaveBeenCalled();
  });

  it("requests reauthorization when the token lacks the required scope", async () => {
    const invokeExecutor = vi.fn();
    const handler = createHandler({
      config,
      invokeExecutor,
      tokenVerifier: vi
        .fn()
        .mockRejectedValue(new TokenValidationError("insufficient_scope")),
    });
    const response = await handler(
      functionUrlEvent("/mcp", {
        authorization: "Bearer valid-token-without-scope",
        body: jsonRpcRequest("tools/call", {
          name: "read_gremlin",
          arguments: { query: "g.V().limit(1)" },
        }),
      }),
      context,
    );
    const result = resultOf(parseResponseBody(response.body));
    const meta = result._meta as Record<string, unknown>;
    const challenges = meta["mcp/www_authenticate"] as string[];

    expect(challenges).toHaveLength(1);
    expect(challenges[0]).toContain('scope="graph:execute"');
    expect(challenges[0]).toContain('error="insufficient_scope"');
    expect(response.headers?.["www-authenticate"]).toContain(
      'error="insufficient_scope"',
    );
    expect(invokeExecutor).not.toHaveBeenCalled();
  });

  it("rejects a query over the UTF-8 byte limit", async () => {
    const invokeExecutor = vi.fn();
    const handler = createHandler({
      config,
      invokeExecutor,
      tokenVerifier: vi.fn().mockResolvedValue({ sub: config.allowedSubject }),
    });
    const response = await handler(
      functionUrlEvent("/mcp", {
        authorization: "Bearer valid-token",
        body: jsonRpcRequest("tools/call", {
          name: "read_gremlin",
          arguments: { query: "é".repeat(MAX_QUERY_BYTES / 2 + 1) },
        }),
      }),
      context,
    );
    const result = resultOf(parseResponseBody(response.body));
    const structured = result.structuredContent as Record<string, unknown>;

    expect((structured.error as Record<string, unknown>).code).toBe(
      "QUERY_INVALID",
    );
    expect(invokeExecutor).not.toHaveBeenCalled();
  });

  it("accepts a valid token and maps structured and model-readable success", async () => {
    const execution: ExecutionResponse = {
      ok: true,
      result: { data: [{ id: "v1" }] },
      meta: {
        request_id: "opaque",
        elapsed_ms: 12,
        result_bytes: 22,
        retry_safe: false,
      },
    };
    const invokeExecutor = vi.fn().mockResolvedValue(execution);
    const handler = createHandler({
      config,
      invokeExecutor,
      tokenVerifier: vi.fn().mockResolvedValue({ sub: config.allowedSubject }),
    });
    const response = await handler(
      functionUrlEvent("/mcp", {
        authorization: "Bearer valid-token",
        body: jsonRpcRequest("tools/call", {
          name: "read_gremlin",
          arguments: { query: "g.V().limit(1)" },
        }),
      }),
      context,
    );
    const result = resultOf(parseResponseBody(response.body));

    expect(result.structuredContent).toEqual(execution);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(execution) },
    ]);
    expect(invokeExecutor).toHaveBeenCalledWith(
      "g.V().limit(1)",
      expect.any(String),
    );
  });

  it("forwards verified add/update and delete traversals unchanged", async () => {
    const execution: ExecutionResponse = {
      ok: true,
      result: { data: [] },
      meta: {
        request_id: "opaque",
        elapsed_ms: 1,
        result_bytes: 11,
        retry_safe: false,
      },
    };
    const invokeExecutor = vi.fn().mockResolvedValue(execution);
    const handler = createHandler({
      config,
      invokeExecutor,
      tokenVerifier: vi.fn().mockResolvedValue({ sub: config.allowedSubject }),
    });

    for (const [name, query] of [
      ["write_gremlin", "g.V('v1').property(single,'name','Ada')"],
      ["delete_gremlin", "g.V('v1').properties('obsolete').drop().iterate()"],
    ] as const) {
      const response = await handler(
        functionUrlEvent("/mcp", {
          authorization: "Bearer valid-token",
          body: jsonRpcRequest("tools/call", {
            name,
            arguments: { query },
          }),
        }),
        context,
      );
      const result = resultOf(parseResponseBody(response.body));
      expect(result.structuredContent).toEqual(execution);
      expect(invokeExecutor).toHaveBeenCalledWith(query, expect.any(String));
    }
  });

  it.each([
    ["read_gremlin", "g.V().coalesce(__.values('name'),__.addV('person'))"],
    [
      "write_gremlin",
      "g.V('v1').property('name','Ada').sideEffect(__.properties('obsolete').drop())",
    ],
    ["read_gremlin", "g.V().limit(1"],
  ])(
    "rejects unsafe or malformed input for %s before invocation",
    async (name, query) => {
      const invokeExecutor = vi.fn();
      const handler = createHandler({
        config,
        invokeExecutor,
        tokenVerifier: vi
          .fn()
          .mockResolvedValue({ sub: config.allowedSubject }),
      });
      const response = await handler(
        functionUrlEvent("/mcp", {
          authorization: "Bearer valid-token",
          body: jsonRpcRequest("tools/call", {
            name,
            arguments: { query },
          }),
        }),
        context,
      );
      const result = resultOf(parseResponseBody(response.body));
      const structured = result.structuredContent as Record<string, unknown>;
      const error = structured.error as Record<string, unknown>;

      expect(error.code).toBe("QUERY_INVALID");
      expect(error.request_id).toEqual(expect.any(String));
      expect(error.retry_safe).toBe(false);
      expect(invokeExecutor).not.toHaveBeenCalled();
    },
  );

  it("preserves the unknown mutation outcome warning after ambiguous executor failure", async () => {
    const invokeExecutor = vi
      .fn()
      .mockRejectedValue(new ExecutorInvocationError(false));
    const handler = createHandler({
      config,
      invokeExecutor,
      tokenVerifier: vi.fn().mockResolvedValue({ sub: config.allowedSubject }),
    });
    const response = await handler(
      functionUrlEvent("/mcp", {
        authorization: "Bearer valid-token",
        body: jsonRpcRequest("tools/call", {
          name: "write_gremlin",
          arguments: { query: "g.addV('person')" },
        }),
      }),
      context,
    );
    const result = resultOf(parseResponseBody(response.body));
    const structured = result.structuredContent as Record<string, unknown>;
    const error = structured.error as Record<string, unknown>;

    expect(error).toMatchObject({
      code: "UNKNOWN_MUTATION_OUTCOME",
      retry_safe: false,
    });
    expect(error.message).toContain("do not retry blindly");
    expect(invokeExecutor).toHaveBeenCalledTimes(1);
  });

  it("keeps definitely-not-invoked executor failures retry-distinct", async () => {
    const invokeExecutor = vi
      .fn()
      .mockRejectedValue(new ExecutorInvocationError(true));
    const handler = createHandler({
      config,
      invokeExecutor,
      tokenVerifier: vi.fn().mockResolvedValue({ sub: config.allowedSubject }),
    });
    const response = await handler(
      functionUrlEvent("/mcp", {
        authorization: "Bearer valid-token",
        body: jsonRpcRequest("tools/call", {
          name: "read_gremlin",
          arguments: { query: "g.V().limit(1)" },
        }),
      }),
      context,
    );
    const result = resultOf(parseResponseBody(response.body));
    const structured = result.structuredContent as Record<string, unknown>;
    const error = structured.error as Record<string, unknown>;

    expect(error).toMatchObject({
      code: "NEPTUNE_UNAVAILABLE",
      retry_safe: false,
    });
    expect(error.message).toBe("The private executor is unavailable.");
  });

  it("publishes protected-resource metadata and reports readiness without secrets", async () => {
    const handler = createHandler({ config });
    const metadata = await handler(
      functionUrlEvent("/.well-known/oauth-protected-resource", {
        method: "GET",
      }),
      context,
    );
    const health = await handler(
      functionUrlEvent("/healthz", { method: "GET" }),
      context,
    );

    expect(parseResponseBody(metadata.body)).toEqual({
      resource: config.canonicalMcpUrl,
      authorization_servers: [config.oauthIssuer],
      scopes_supported: ["graph:execute"],
      bearer_methods_supported: ["header"],
    });
    expect(parseResponseBody(health.body)).toEqual({
      service: "sol-neptune-gremlin",
      version: "1.0.0",
      ready: true,
    });
  });

  it("fails closed during deployment stage one", async () => {
    const handler = createHandler({
      config: {
        ...config,
        enabled: false,
        canonicalMcpUrl: "",
        oauthIssuer: "",
        allowedSubject: "",
      },
    });
    const health = await handler(
      functionUrlEvent("/healthz", { method: "GET" }),
      context,
    );
    const mcp = await handler(
      functionUrlEvent("/mcp", { body: jsonRpcRequest("tools/list", {}) }),
      context,
    );

    expect(parseResponseBody(health.body)).toMatchObject({ ready: false });
    expect(mcp.statusCode).toBe(503);
  });
});
