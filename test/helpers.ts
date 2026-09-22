import type { APIGatewayProxyEventV2 } from "aws-lambda";

export const TEST_HOST = "test.lambda-url.us-east-1.on.aws";

export function functionUrlEvent(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    authorization?: string;
  } = {},
): APIGatewayProxyEventV2 {
  const method = options.method ?? "POST";
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      host: TEST_HOST,
      ...(options.authorization === undefined
        ? {}
        : { authorization: options.authorization }),
    },
    requestContext: {
      accountId: "anonymous",
      apiId: "test",
      domainName: TEST_HOST,
      domainPrefix: "test",
      http: {
        method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "request-id",
      routeKey: "$default",
      stage: "$default",
      time: "21/Sep/2026:00:00:00 +0000",
      timeEpoch: 1_790_000_000_000,
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
    isBase64Encoded: false,
  };
}

export function jsonRpcRequest(
  method: string,
  params?: unknown,
  id = 1,
): unknown {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  };
}

export function parseResponseBody(
  body: string | undefined,
): Record<string, unknown> {
  if (!body) {
    throw new Error("Expected a JSON response body");
  }
  return JSON.parse(body) as Record<string, unknown>;
}
