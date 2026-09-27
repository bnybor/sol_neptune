export type SafeLogFields = {
  component: "mcp" | "executor";
  event: string;
  request_id?: string;
  lambda_request_id?: string;
  status?: string;
  elapsed_ms?: number;
  result_bytes?: number;
  sanitized_error_class?: string;
  operation_id?: string;
  tool_name?: string;
  authority_epoch?: string;
  canonical_payload_hash?: string;
  allocated_ids?: string;
  expected_revision?: number;
  observed_revision?: number;
};

export type SafeLogger = {
  info(fields: SafeLogFields): void;
  error(fields: SafeLogFields): void;
};

export const safeLogger: SafeLogger = {
  info(fields) {
    console.info(JSON.stringify(fields));
  },
  error(fields) {
    console.error(JSON.stringify(fields));
  },
};

export function sanitizedErrorClass(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string" &&
    /^[A-Za-z0-9_$.-]{1,128}$/.test(error.name)
  ) {
    return error.name;
  }

  return "UnknownError";
}
