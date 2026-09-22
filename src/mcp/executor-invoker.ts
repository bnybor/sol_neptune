import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

import {
  EXECUTOR_SOURCE,
  executionResponseSchema,
  type ExecutionResponse,
} from "../shared/contracts.js";

export type ExecutorInvoker = (
  query: string,
  requestId: string,
) => Promise<ExecutionResponse>;

export class ExecutorInvocationError extends Error {
  public readonly definitelyNotInvoked: boolean;

  public constructor(definitelyNotInvoked: boolean) {
    super("Executor invocation failed");
    this.name = "ExecutorInvocationError";
    this.definitelyNotInvoked = definitelyNotInvoked;
  }
}

export const LAMBDA_CLIENT_MAX_ATTEMPTS = 1;

export function createExecutorInvoker(
  functionName: string,
  client: Pick<LambdaClient, "send"> = new LambdaClient({
    maxAttempts: LAMBDA_CLIENT_MAX_ATTEMPTS,
  }),
): ExecutorInvoker {
  return async (query, requestId) => {
    try {
      const output = await client.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: "RequestResponse",
          Payload: Buffer.from(
            JSON.stringify({
              source: EXECUTOR_SOURCE,
              request_id: requestId,
              query,
            }),
          ),
        }),
      );

      if (output.FunctionError || !output.Payload) {
        throw new ExecutorInvocationError(false);
      }

      const decoded: unknown = JSON.parse(
        Buffer.from(output.Payload).toString("utf8"),
      );
      const parsed = executionResponseSchema.safeParse(decoded);
      if (!parsed.success) {
        throw new ExecutorInvocationError(false);
      }

      return parsed.data;
    } catch (error) {
      if (error instanceof ExecutorInvocationError) {
        throw error;
      }

      const name =
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        typeof error.name === "string"
          ? error.name
          : "";
      const definitelyNotInvoked =
        name === "AccessDeniedException" ||
        name === "ResourceNotFoundException";
      throw new ExecutorInvocationError(definitelyNotInvoked);
    }
  };
}
