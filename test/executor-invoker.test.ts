import { InvokeCommand } from "@aws-sdk/client-lambda";

import {
  createExecutorInvoker,
  ExecutorInvocationError,
  LAMBDA_CLIENT_MAX_ATTEMPTS,
} from "../src/mcp/executor-invoker.js";

describe("executor invocation", () => {
  it("also disables retries on the Lambda invocation path", () => {
    expect(LAMBDA_CLIENT_MAX_ATTEMPTS).toBe(1);
  });

  it("invokes synchronously with the private executor request envelope", async () => {
    const send = vi.fn().mockResolvedValue({
      Payload: Buffer.from(
        JSON.stringify({
          ok: true,
          result: { data: [] },
          meta: {
            request_id: "request",
            elapsed_ms: 1,
            result_bytes: 11,
            retry_safe: false,
          },
        }),
      ),
    });
    const invoke = createExecutorInvoker("private-executor", { send });
    await invoke("g.V().limit(1)", "request");

    const command = send.mock.calls[0]?.[0] as InvokeCommand;
    expect(command.input).toMatchObject({
      FunctionName: "private-executor",
      InvocationType: "RequestResponse",
    });
    expect(
      JSON.parse(
        Buffer.from(command.input.Payload as Uint8Array).toString("utf8"),
      ),
    ).toEqual({
      source: "sol-neptune-mcp",
      request_id: "request",
      query: "g.V().limit(1)",
    });
  });

  it("treats a malformed executor response as an unknown invocation outcome", async () => {
    const invoke = createExecutorInvoker("private-executor", {
      send: vi.fn().mockResolvedValue({ Payload: Buffer.from("{}") }),
    });
    await expect(invoke("g.addV('x')", "request")).rejects.toMatchObject({
      name: "ExecutorInvocationError",
      definitelyNotInvoked: false,
    });
  });

  it("marks access denial as definitely not invoked", async () => {
    const error = new Error("denied");
    error.name = "AccessDeniedException";
    const invoke = createExecutorInvoker("private-executor", {
      send: vi.fn().mockRejectedValue(error),
    });
    await expect(invoke("g.V()", "request")).rejects.toEqual(
      expect.objectContaining<Partial<ExecutorInvocationError>>({
        definitelyNotInvoked: true,
      }),
    );
  });
});
