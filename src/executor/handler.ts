import {
  ExecuteGremlinQueryCommand,
  GetPropertygraphStreamCommand,
  type ExecuteGremlinQueryCommandOutput,
} from "@aws-sdk/client-neptunedata";
import type { Context } from "aws-lambda";

import {
  executorRequestSchema,
  failure,
  MAX_QUERY_BYTES,
  MAX_STRUCTURED_RESULT_BYTES,
  type ExecutionResponse,
  type ExecutionSuccess,
} from "../shared/contracts.js";
import {
  safeLogger,
  sanitizedErrorClass,
  type SafeLogger,
} from "../shared/logging.js";
import {
  getNeptuneClient,
  resetNeptuneClient,
  type NeptuneSender,
} from "./neptune-client.js";
import { validateGremlinForTool } from "../mcp/gremlin-safety.js";
import { SearchFailure, searchGremlin } from "./search.js";

const GREMLIN_SERIALIZER = "application/vnd.gremlin-v3.0+json;types=false";

type ExecutorDependencies = {
  getClient: () => NeptuneSender;
  resetClient: () => void;
  logger: SafeLogger;
  now: () => number;
};

const defaultDependencies: ExecutorDependencies = {
  getClient: getNeptuneClient,
  resetClient: resetNeptuneClient,
  logger: safeLogger,
  now: Date.now,
};

function errorName(error: unknown): string {
  return sanitizedErrorClass(error);
}

function httpStatus(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "$metadata" in error &&
    typeof error.$metadata === "object" &&
    error.$metadata !== null &&
    "httpStatusCode" in error.$metadata &&
    typeof error.$metadata.httpStatusCode === "number"
  ) {
    return error.$metadata.httpStatusCode;
  }

  return undefined;
}

export function isConnectionLevelFailure(error: unknown): boolean {
  const name = errorName(error);
  const connectionNames = new Set([
    "AbortError",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EPIPE",
    "TimeoutError",
  ]);

  if (connectionNames.has(name)) {
    return true;
  }

  if (typeof error === "object" && error !== null && "code" in error) {
    return typeof error.code === "string" && connectionNames.has(error.code);
  }

  return false;
}

function mapNeptuneError(
  error: unknown,
  requestId: string,
  elapsedMs: number,
): ExecutionResponse {
  const name = errorName(error);
  const status = httpStatus(error);

  if (
    name === "BadRequestException" ||
    name === "MalformedQueryException" ||
    name === "InvalidParameterException" ||
    status === 400
  ) {
    return failure(
      "QUERY_INVALID",
      "Neptune rejected the Gremlin query.",
      requestId,
      {
        elapsedMs,
        resultBytes: 0,
      },
    );
  }

  if (name === "TimeLimitExceededException") {
    return failure(
      "QUERY_TIMEOUT",
      "The Gremlin query exceeded its time limit.",
      requestId,
      {
        elapsedMs,
        resultBytes: 0,
      },
    );
  }

  if (isConnectionLevelFailure(error)) {
    return failure(
      "UNKNOWN_MUTATION_OUTCOME",
      "The Neptune response was lost after execution may have started; do not retry blindly.",
      requestId,
      { elapsedMs, resultBytes: 0 },
    );
  }

  if (
    name === "ServiceUnavailableException" ||
    name === "ServerShutdownException" ||
    name === "ThrottlingException" ||
    status === 429 ||
    status === 503
  ) {
    return failure(
      "NEPTUNE_UNAVAILABLE",
      "Neptune is temporarily unavailable.",
      requestId,
      {
        elapsedMs,
        resultBytes: 0,
      },
    );
  }

  return failure(
    "INTERNAL_ERROR",
    "The executor could not complete the request.",
    requestId,
    {
      elapsedMs,
      resultBytes: 0,
    },
  );
}

function successResponse(
  result: unknown,
  requestId: string,
  elapsedMs: number,
): ExecutionResponse {
  const resultBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  const response: ExecutionSuccess = {
    ok: true,
    result,
    meta: {
      request_id: requestId,
      elapsed_ms: elapsedMs,
      result_bytes: resultBytes,
      retry_safe: false,
    },
  };

  const structuredBytes = Buffer.byteLength(JSON.stringify(response), "utf8");
  if (structuredBytes > MAX_STRUCTURED_RESULT_BYTES) {
    return failure(
      "RESULT_TOO_LARGE",
      "Execution completed, but the result was omitted because it exceeded the response limit.",
      requestId,
      {
        elapsedMs,
        resultBytes,
        executionCompleted: true,
      },
    );
  }

  return response;
}

export function createExecutorHandler(
  dependencies: Partial<ExecutorDependencies> = {},
): (
  event: unknown,
  context: Pick<Context, "awsRequestId">,
) => Promise<ExecutionResponse> {
  const deps = { ...defaultDependencies, ...dependencies };

  return async (event, context) => {
    const startedAt = deps.now();
    const parsed = executorRequestSchema.safeParse(event);
    const requestId = parsed.success
      ? parsed.data.request_id
      : "invalid-request";

    if (!parsed.success) {
      const response = failure(
        "QUERY_INVALID",
        "The executor request was invalid or unauthorized.",
        requestId,
      );
      deps.logger.error({
        component: "executor",
        event: "query_rejected",
        lambda_request_id: context.awsRequestId,
        request_id: requestId,
        status: response.error.code,
      });
      return response;
    }

    if (
      Buffer.byteLength(parsed.data.query, "utf8") > MAX_QUERY_BYTES ||
      (parsed.data.search?.blacklist_query !== undefined &&
        Buffer.byteLength(parsed.data.search.blacklist_query, "utf8") >
          MAX_QUERY_BYTES)
    ) {
      return failure(
        "QUERY_INVALID",
        `The Gremlin query exceeds ${MAX_QUERY_BYTES.toLocaleString("en-US")} UTF-8 bytes.`,
        requestId,
      );
    }

    if (
      parsed.data.search !== undefined &&
      (!validateGremlinForTool(parsed.data.query, "read").ok ||
        (parsed.data.search.blacklist_query !== undefined &&
          !validateGremlinForTool(parsed.data.search.blacklist_query, "read")
            .ok))
    ) {
      return failure(
        "QUERY_INVALID",
        "Search seed and blacklist queries must both be verified read-only.",
        requestId,
      );
    }

    let response: ExecutionResponse;
    let caughtError: unknown;
    try {
      const client = deps.getClient();
      if (parsed.data.search !== undefined) {
        const deadline = deps.now() + 11_000;
        const sendOptions = (): { abortSignal: AbortSignal } => {
          const remaining = deadline - deps.now();
          if (remaining <= 0)
            throw new SearchFailure(
              "QUERY_TIMEOUT",
              "The search exceeded its execution budget.",
            );
          return { abortSignal: AbortSignal.timeout(Math.ceil(remaining)) };
        };
        const result = await searchGremlin(
          { query: parsed.data.query, ...parsed.data.search },
          {
            async query(query) {
              if (!validateGremlinForTool(query, "read").ok) {
                throw new SearchFailure(
                  "QUERY_INVALID",
                  "An internal search traversal failed read-only validation.",
                );
              }
              const output = await client.send(
                new ExecuteGremlinQueryCommand({
                  gremlinQuery: query,
                  serializer: "application/vnd.gremlin-v3.0+json",
                }),
                sendOptions(),
              );
              const result = output.result ?? { data: [] };
              if (
                Buffer.byteLength(JSON.stringify(result), "utf8") >
                MAX_STRUCTURED_RESULT_BYTES
              ) {
                throw new SearchFailure(
                  "RESULT_TOO_LARGE",
                  "A search read exceeds the response limit; narrow the query or blacklist hubs.",
                );
              }
              return result;
            },
            async streamHead() {
              const output = await client.send(
                new GetPropertygraphStreamCommand({
                  iteratorType: "LATEST",
                  limit: 1,
                }),
                sendOptions(),
              );
              const head = output.lastEventId;
              if (
                !head ||
                typeof head.commitNum !== "string" ||
                typeof head.opNum !== "string"
              ) {
                throw new SearchFailure(
                  "NEPTUNE_UNAVAILABLE",
                  "A Neptune stream head is required for consistent multi-query search.",
                );
              }
              return { commitNum: head.commitNum, opNum: head.opNum };
            },
          },
          { now: deps.now },
        );
        response = successResponse(result, requestId, deps.now() - startedAt);
      } else {
        const output: ExecuteGremlinQueryCommandOutput = await client.send(
          new ExecuteGremlinQueryCommand({
            gremlinQuery: parsed.data.query,
            serializer: GREMLIN_SERIALIZER,
          }),
        );
        response = successResponse(
          output.result ?? null,
          requestId,
          deps.now() - startedAt,
        );
      }
    } catch (error) {
      caughtError = error;
      if (isConnectionLevelFailure(error)) {
        deps.resetClient();
      }
      response =
        error instanceof SearchFailure
          ? failure(error.code, error.message, requestId, {
              elapsedMs: deps.now() - startedAt,
              resultBytes: 0,
            })
          : parsed.data.search !== undefined &&
              errorName(error) === "AbortError"
            ? failure(
                "QUERY_TIMEOUT",
                "The search exceeded its execution budget; no partial graph is returned.",
                requestId,
                { elapsedMs: deps.now() - startedAt, resultBytes: 0 },
              )
            : mapNeptuneError(error, requestId, deps.now() - startedAt);
    }

    const fields = {
      component: "executor" as const,
      event: "query_complete",
      lambda_request_id: context.awsRequestId,
      request_id: requestId,
      status: response.ok ? "OK" : response.error.code,
      elapsed_ms: response.ok
        ? response.meta.elapsed_ms
        : (response.meta?.elapsed_ms ?? deps.now() - startedAt),
      result_bytes: response.ok
        ? response.meta.result_bytes
        : (response.meta?.result_bytes ?? 0),
      ...(caughtError === undefined
        ? {}
        : { sanitized_error_class: sanitizedErrorClass(caughtError) }),
    };

    if (response.ok) {
      deps.logger.info(fields);
    } else {
      deps.logger.error(fields);
    }

    return response;
  };
}

export const handler = createExecutorHandler();
