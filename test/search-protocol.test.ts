import { createHandler } from "../src/mcp/handler.js";
import type { McpConfig } from "../src/mcp/config.js";
import {
  MAX_QUERY_BYTES,
  type ExecutionResponse,
} from "../src/shared/contracts.js";
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
  allowedSubject: "test-owner",
  serviceVersion: "2.2.0",
};
const context = { awsRequestId: "request" };
const success: ExecutionResponse = {
  ok: true,
  result: { graph: {}, search: { complete: true } },
  meta: { request_id: "r", elapsed_ms: 1, result_bytes: 2, retry_safe: false },
};

function setup(now?: () => number) {
  const invokeExecutor = vi.fn().mockResolvedValue(success);
  const handler = createHandler({
    config,
    invokeExecutor,
    tokenVerifier: vi.fn().mockResolvedValue({ sub: config.allowedSubject }),
    ...(now === undefined ? {} : { now }),
  });
  const call = async (name: string, args: unknown, auth = true) => {
    const response = await handler(
      functionUrlEvent("/mcp", {
        ...(auth ? { authorization: "Bearer test-token" } : {}),
        body: jsonRpcRequest("tools/call", { name, arguments: args }),
      }),
      context,
    );
    const rpc = parseResponseBody(response.body);
    return { response, result: rpc.result as Record<string, unknown> };
  };
  return { invokeExecutor, call };
}
function padded(base: string, size: number): string {
  const remaining = size - Buffer.byteLength(base) - 4;
  return `${base}/*${"é".repeat(Math.floor(remaining / 2))}${remaining % 2 ? " " : ""}*/`;
}

describe("search and clock MCP protocol", () => {
  it.each(["compact", "graphson"])(
    "passes explicit %s format through",
    async (format) => {
      const { call, invokeExecutor } = setup();
      expect(
        (
          await call("search_gremlin", {
            query: "g.V().limit(1)",
            depth: 0,
            format,
          })
        ).result.isError,
      ).toBe(false);
      expect(invokeExecutor).toHaveBeenLastCalledWith(
        "g.V().limit(1)",
        expect.any(String),
        { search: { depth: 0, format } },
      );
    },
  );
  it.each([null, 1, "binary", "GraphSON"])(
    "rejects invalid format %s before execution",
    async (format) => {
      const { call, invokeExecutor } = setup();
      expect(
        (await call("search_gremlin", { query: "g.V()", format })).result
          .structuredContent,
      ).toMatchObject({ error: { code: "QUERY_INVALID" } });
      expect(invokeExecutor).not.toHaveBeenCalled();
    },
  );
  it("passes default 3 and accepted depth boundaries through to the private executor", async () => {
    const { call, invokeExecutor } = setup();
    for (const depth of [undefined, 0, 7]) {
      const { result } = await call("search_gremlin", {
        query: "g.V().limit(1)",
        ...(depth === undefined ? {} : { depth }),
      });
      expect(result.isError).toBe(false);
      expect(invokeExecutor).toHaveBeenLastCalledWith(
        "g.V().limit(1)",
        expect.any(String),
        { search: { depth: depth ?? 3, format: "compact" } },
      );
    }
  });
  it.each([-1, 8, 1.5, "3", null])(
    "rejects depth %s before execution",
    async (depth) => {
      const { call, invokeExecutor } = setup();
      const { result } = await call("search_gremlin", {
        query: "g.V()",
        depth,
      });
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: "QUERY_INVALID" },
      });
      expect(invokeExecutor).not.toHaveBeenCalled();
    },
  );
  it.each([
    { query: "g.V().drop()" },
    { query: "g.V()", blacklist_query: "g.addV('bad')" },
    { query: "g.V()", blacklist_query: "g.V().sideEffect(__.drop())" },
    { query: "g.V()", blacklist_query: "g.V().execute()" },
  ])(
    "rejects unsafe seed or blacklist before private invocation: %j",
    async (args) => {
      const { call, invokeExecutor } = setup();
      const { result } = await call("search_gremlin", args);
      expect(result.structuredContent).toMatchObject({
        error: { code: "QUERY_INVALID" },
      });
      expect(invokeExecutor).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["read_gremlin", "g.V().limit(1)"],
    ["write_gremlin", "g.addV('test')"],
    ["delete_gremlin", "g.V('test').drop()"],
    ["search_gremlin", "g.V().limit(1)"],
  ])("enforces exactly 256 KiB of UTF-8 for %s", async (name, base) => {
    const { call, invokeExecutor } = setup();
    const exact = padded(base, MAX_QUERY_BYTES);
    expect(Buffer.byteLength(exact, "utf8")).toBe(MAX_QUERY_BYTES);
    expect(
      (
        await call(name, {
          query: exact,
          ...(name === "search_gremlin" ? { depth: 0 } : {}),
        })
      ).result.isError,
    ).toBe(false);
    expect(invokeExecutor).toHaveBeenCalledTimes(1);
    const over = padded(base, MAX_QUERY_BYTES + 1);
    expect(over.length).toBeLessThan(MAX_QUERY_BYTES);
    expect(
      (await call(name, { query: over })).result.structuredContent,
    ).toMatchObject({ error: { code: "QUERY_INVALID" } });
    expect(invokeExecutor).toHaveBeenCalledTimes(1);
  });
  it("enforces the byte limit independently on the blacklist query", async () => {
    const { call, invokeExecutor } = setup();
    const blacklist = padded("g.V().limit(0)", MAX_QUERY_BYTES);
    expect(
      (
        await call("search_gremlin", {
          query: "g.V()",
          blacklist_query: blacklist,
        })
      ).result.isError,
    ).toBe(false);
    expect(invokeExecutor).toHaveBeenLastCalledWith(
      "g.V()",
      expect.any(String),
      { search: { depth: 3, format: "compact", blacklist_query: blacklist } },
    );
    expect(
      (
        await call("search_gremlin", {
          query: "g.V()",
          blacklist_query: `${blacklist} `,
        })
      ).result.structuredContent,
    ).toMatchObject({ error: { code: "QUERY_INVALID" } });
    expect(invokeExecutor).toHaveBeenCalledTimes(1);
  });
  it("authenticates search and clock without calling the executor for anonymous calls", async () => {
    const { call, invokeExecutor } = setup();
    for (const [name, args] of [
      ["search_gremlin", { query: "g.V()" }],
      ["get_current_time", {}],
    ] as const) {
      expect(
        (await call(name, args, false)).result.structuredContent,
      ).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
    }
    expect(invokeExecutor).not.toHaveBeenCalled();
  });
  it("samples a fresh server clock once per call, with no graph I/O", async () => {
    const firstMs = Date.parse("2026-10-13T19:00:00.123Z");
    const now = vi
      .fn()
      .mockReturnValueOnce(firstMs)
      .mockReturnValueOnce(firstMs + 3000);
    const { call, invokeExecutor } = setup(now);
    const first = await call("get_current_time", {});
    const second = await call("get_current_time", {});
    expect(first.result.structuredContent).toEqual({
      server_time_utc: "2026-10-13T19:00:00.123Z",
      unix_time_ms: firstMs,
    });
    expect(second.result.structuredContent).toEqual({
      server_time_utc: "2026-10-13T19:00:03.123Z",
      unix_time_ms: firstMs + 3000,
    });
    expect(now).toHaveBeenCalledTimes(2);
    expect(first.response.headers?.["cache-control"]).toBe("no-store");
    expect(invokeExecutor).not.toHaveBeenCalled();
    expect(
      (await call("get_current_time", { query: "g.V()" })).result
        .structuredContent,
    ).toMatchObject({ error: { code: "QUERY_INVALID" } });
    expect(now).toHaveBeenCalledTimes(2);
  });
});
