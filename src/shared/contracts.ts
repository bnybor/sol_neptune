import { z } from "zod";

export const MAX_QUERY_BYTES = 262_144;
export const MAX_STRUCTURED_RESULT_BYTES = 1_048_576;
export const DEFAULT_SEARCH_DEPTH = 3;
export const MAX_SEARCH_DEPTH = 7;
export const GRAPH_EXECUTE_SCOPE = "graph:execute";
export const EXECUTOR_SOURCE = "sol-neptune-mcp";

export const searchOptionsSchema = z
  .object({
    format: z.enum(["compact", "graphson"]).optional(),
    blacklist_query: z.string().min(1).max(MAX_QUERY_BYTES).optional(),
    depth: z
      .number()
      .int()
      .min(0)
      .max(MAX_SEARCH_DEPTH)
      .default(DEFAULT_SEARCH_DEPTH),
  })
  .strict();

export const searchInputSchema = searchOptionsSchema.extend({
  query: z.string().min(1).max(MAX_QUERY_BYTES),
});

export type SearchOptions = z.infer<typeof searchOptionsSchema>;
export type SearchInput = z.infer<typeof searchInputSchema>;

export const executorRequestSchema = z
  .object({
    source: z.literal(EXECUTOR_SOURCE),
    request_id: z.string().min(1).max(128),
    query: z.string().min(1),
    search: searchOptionsSchema.optional(),
  })
  .strict();

export type ExecutorRequest = z.infer<typeof executorRequestSchema>;

export const errorCodeSchema = z.enum([
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "QUERY_INVALID",
  "QUERY_TIMEOUT",
  "RESULT_TOO_LARGE",
  "RESULT_UNSUPPORTED",
  "SEARCH_LIMIT_EXCEEDED",
  "GRAPH_CHANGED",
  "NEPTUNE_UNAVAILABLE",
  "UNKNOWN_MUTATION_OUTCOME",
  "INTERNAL_ERROR",
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

const executionMetaSchema = z
  .object({
    request_id: z.string(),
    elapsed_ms: z.number().nonnegative(),
    result_bytes: z.number().int().nonnegative(),
    retry_safe: z.literal(false),
  })
  .strict();

export const executionSuccessSchema = z
  .object({
    ok: z.literal(true),
    result: z.unknown(),
    meta: executionMetaSchema,
  })
  .strict();

export const executionFailureSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: errorCodeSchema,
        message: z.string(),
        request_id: z.string(),
        retry_safe: z.literal(false),
        execution_completed: z.boolean().optional(),
      })
      .strict(),
    meta: executionMetaSchema.optional(),
  })
  .strict();

export const executionResponseSchema = z.union([
  executionSuccessSchema,
  executionFailureSchema,
]);

export type ExecutionSuccess = z.infer<typeof executionSuccessSchema>;
export type ExecutionFailure = z.infer<typeof executionFailureSchema>;
export type ExecutionResponse = z.infer<typeof executionResponseSchema>;

export function failure(
  code: ErrorCode,
  message: string,
  requestId: string,
  options: {
    elapsedMs?: number;
    resultBytes?: number;
    executionCompleted?: boolean;
  } = {},
): ExecutionFailure {
  const elapsedMs = options.elapsedMs;
  const resultBytes = options.resultBytes;

  return {
    ok: false,
    error: {
      code,
      message,
      request_id: requestId,
      retry_safe: false,
      ...(options.executionCompleted === undefined
        ? {}
        : { execution_completed: options.executionCompleted }),
    },
    ...(elapsedMs === undefined || resultBytes === undefined
      ? {}
      : {
          meta: {
            request_id: requestId,
            elapsed_ms: elapsedMs,
            result_bytes: resultBytes,
            retry_safe: false,
          },
        }),
  };
}
