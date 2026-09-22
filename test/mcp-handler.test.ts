import type { ExecutionResponse } from "../src/shared/contracts.js";
import type { McpConfig } from "../src/mcp/config.js";
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

  it("lists exactly one tool with the exact schema, OAuth scheme, and annotations", async () => {
    const handler = createHandler({ config });
    const response = await handler(
      functionUrlEvent("/mcp", { body: jsonRpcRequest("tools/list", {}) }),
      context,
    );
    const result = resultOf(parseResponseBody(response.body));
    const tools = result.tools as Record<string, unknown>[];

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "execute_gremlin",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: 65_536 },
        },
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
      securitySchemes: [{ type: "oauth2", scopes: ["graph:execute"] }],
    });
  });

  it("rejects a missing token with both OAuth challenge mechanisms", async () => {
    const handler = createHandler({ config });
    const response = await handler(
      functionUrlEvent("/mcp", {
        body: jsonRpcRequest("tools/call", {
          name: "execute_gremlin",
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
          name: "execute_gremlin",
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
          name: "execute_gremlin",
          arguments: { query: "é".repeat(32_769) },
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
          name: "execute_gremlin",
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
