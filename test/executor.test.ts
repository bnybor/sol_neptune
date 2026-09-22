import type { SafeLogFields, SafeLogger } from "../src/shared/logging.js";
import { createExecutorHandler } from "../src/executor/handler.js";
import {
  neptuneClientConfig,
  type NeptuneSender,
} from "../src/executor/neptune-client.js";

const context = { awsRequestId: "lambda-request" };
const baseEvent = {
  source: "sol-neptune-mcp",
  request_id: "opaque-request",
  query: "g.V().limit(1)",
};

function mockSender(implementation: () => Promise<unknown>): NeptuneSender {
  return { send: vi.fn(implementation) } as NeptuneSender;
}

function captureLogger(): { logger: SafeLogger; entries: SafeLogFields[] } {
  const entries: SafeLogFields[] = [];
  return {
    entries,
    logger: {
      info(fields) {
        entries.push(fields);
      },
      error(fields) {
        entries.push(fields);
      },
    },
  };
}

describe("private Neptune executor", () => {
  it("configures the Neptune SDK for exactly one attempt", () => {
    const config = neptuneClientConfig({
      NEPTUNE_ENDPOINT: "cluster.example",
      NEPTUNE_PORT: "8182",
      AWS_REGION: "us-east-1",
    });
    expect(config.maxAttempts).toBe(1);
  });

  it("maps a successful read without coercing the result", async () => {
    const result = { data: [{ id: 123, label: "node" }] };
    const handler = createExecutorHandler({
      getClient: () => mockSender(() => Promise.resolve({ result })),
      now: vi.fn().mockReturnValueOnce(100).mockReturnValue(112),
    });

    await expect(handler(baseEvent, context)).resolves.toEqual({
      ok: true,
      result,
      meta: {
        request_id: "opaque-request",
        elapsed_ms: 12,
        result_bytes: Buffer.byteLength(JSON.stringify(result)),
        retry_safe: false,
      },
    });
  });

  it("maps a successful mutation result", async () => {
    const result = { data: [{ id: "new-vertex" }] };
    const handler = createExecutorHandler({
      getClient: () => mockSender(() => Promise.resolve({ result })),
    });
    const response = await handler(
      { ...baseEvent, query: "g.addV('temporary')" },
      context,
    );
    expect(response).toMatchObject({ ok: true, result });
  });

  it.each([
    ["MalformedQueryException", "QUERY_INVALID"],
    ["TimeLimitExceededException", "QUERY_TIMEOUT"],
    ["ServiceUnavailableException", "NEPTUNE_UNAVAILABLE"],
  ])("maps %s to %s", async (name, code) => {
    const error = new Error("sensitive raw error");
    error.name = name;
    const handler = createExecutorHandler({
      getClient: () => mockSender(() => Promise.reject(error)),
    });
    const response = await handler(baseEvent, context);
    expect(response).toMatchObject({
      ok: false,
      error: { code, retry_safe: false },
    });
  });

  it("marks a connection failure as an unknown mutation outcome and rebuilds next time", async () => {
    const error = new Error("connection reset after send");
    error.name = "ECONNRESET";
    const resetClient = vi.fn();
    const handler = createExecutorHandler({
      getClient: () => mockSender(() => Promise.reject(error)),
      resetClient,
    });
    const response = await handler(
      { ...baseEvent, query: "g.addV('may-have-run')" },
      context,
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_MUTATION_OUTCOME", retry_safe: false },
    });
    expect(resetClient).toHaveBeenCalledOnce();
  });

  it("omits an oversized result while stating that execution completed", async () => {
    const result = { data: "x".repeat(1_048_576) };
    const handler = createExecutorHandler({
      getClient: () => mockSender(() => Promise.resolve({ result })),
    });
    const response = await handler(baseEvent, context);
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "RESULT_TOO_LARGE",
        retry_safe: false,
        execution_completed: true,
      },
    });
    expect(JSON.stringify(response)).not.toContain("x".repeat(1_000));
  });

  it("rejects direct or malformed invocation shapes before obtaining a client", async () => {
    const getClient = vi.fn();
    const handler = createExecutorHandler({ getClient });
    const response = await handler(
      { source: "not-the-mcp", query: "g.V()", request_id: "id" },
      context,
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: "QUERY_INVALID" },
    });
    expect(getClient).not.toHaveBeenCalled();
  });

  it("never logs query or result content", async () => {
    const { logger, entries } = captureLogger();
    const handler = createExecutorHandler({
      logger,
      getClient: () =>
        mockSender(() =>
          Promise.resolve({ result: { data: "SECRET_RESULT_CONTENT" } }),
        ),
    });
    await handler(
      { ...baseEvent, query: "g.V().has('secret','SECRET_QUERY_CONTENT')" },
      context,
    );
    const serializedLogs = JSON.stringify(entries);
    expect(serializedLogs).not.toContain("SECRET_QUERY_CONTENT");
    expect(serializedLogs).not.toContain("SECRET_RESULT_CONTENT");
    expect(serializedLogs).toContain("result_bytes");
  });
});
