import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from "aws-lambda";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { safeLogger, sanitizedErrorClass } from "../shared/logging.js";
import { createTokenVerifier, type TokenVerifier } from "./auth.js";
import {
  isReady,
  loadMcpConfig,
  protectedResourceMetadataUrl,
  validateEnabledConfig,
  type McpConfig,
} from "./config.js";
import {
  createExecutorInvoker,
  type ExecutorInvoker,
} from "./executor-invoker.js";
import { createMcpServer } from "./server.js";
import type { SemanticOperations } from "./semantic-operations.js";

type HandlerDependencies = {
  config?: McpConfig;
  invokeExecutor?: ExecutorInvoker;
  semanticOperations?: SemanticOperations;
  tokenVerifier?: TokenVerifier;
};

function jsonResponse(
  statusCode: number,
  value: unknown,
  headers: Record<string, string> = {},
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(value),
    isBase64Encoded: false,
  };
}

function eventBody(event: APIGatewayProxyEventV2): string | undefined {
  if (event.body === undefined) {
    return undefined;
  }
  return event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
}

function eventUrl(event: APIGatewayProxyEventV2): URL {
  const host = event.requestContext.domainName || event.headers.host;
  if (!host) {
    throw new Error("Request host is missing");
  }
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  return new URL(`https://${host}${event.rawPath}${query}`);
}

function toWebRequest(event: APIGatewayProxyEventV2): Request {
  const method = event.requestContext.http.method;
  const body =
    method === "GET" || method === "HEAD" ? undefined : eventBody(event);
  return new Request(eventUrl(event), {
    method,
    headers: event.headers as HeadersInit,
    ...(body === undefined ? {} : { body }),
  });
}

async function toLambdaResponse(
  response: Response,
  challenge: string | undefined,
): Promise<APIGatewayProxyStructuredResultV2> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  if (challenge) {
    headers["www-authenticate"] = challenge;
  }

  return {
    statusCode: response.status,
    headers,
    body: await response.text(),
    isBase64Encoded: false,
  };
}

export function createHandler(
  dependencies: HandlerDependencies = {},
): (
  event: APIGatewayProxyEventV2,
  context: Pick<Context, "awsRequestId">,
) => Promise<APIGatewayProxyStructuredResultV2> {
  const config = dependencies.config ?? loadMcpConfig();

  return async (event, context) => {
    if (
      event.rawPath === "/healthz" &&
      event.requestContext.http.method === "GET"
    ) {
      return jsonResponse(200, {
        service: "sol-neptune-gremlin",
        version: config.serviceVersion,
        ready: isReady(config),
      });
    }

    if (
      event.rawPath === "/.well-known/oauth-protected-resource" &&
      event.requestContext.http.method === "GET"
    ) {
      if (!isReady(config)) {
        return jsonResponse(503, { error: "service_not_configured" });
      }
      return jsonResponse(200, {
        resource: config.canonicalMcpUrl,
        authorization_servers: [config.oauthIssuer],
        scopes_supported: ["graph:execute"],
        bearer_methods_supported: ["header"],
      });
    }

    if (event.rawPath !== "/mcp") {
      return jsonResponse(404, { error: "not_found" });
    }

    if (!isReady(config)) {
      return jsonResponse(
        503,
        { error: "service_unavailable" },
        { "retry-after": "60" },
      );
    }

    try {
      validateEnabledConfig(config);
      if (eventUrl(event).host !== new URL(config.canonicalMcpUrl).host) {
        return jsonResponse(400, { error: "invalid_host" });
      }

      let challenge: string | undefined;
      const tokenVerifier =
        dependencies.tokenVerifier ?? createTokenVerifier(config);
      const invokeExecutor =
        dependencies.invokeExecutor ??
        createExecutorInvoker(config.executorFunctionName);
      const server = createMcpServer({
        authorization: event.headers.authorization,
        config,
        invokeExecutor,
        ...(dependencies.semanticOperations === undefined
          ? {}
          : { semanticOperations: dependencies.semanticOperations }),
        tokenVerifier,
        onAuthChallenge(value) {
          challenge = value;
        },
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });

      try {
        await server.connect(transport);
        const response = await transport.handleRequest(toWebRequest(event));
        return await toLambdaResponse(response, challenge);
      } finally {
        await server.close();
      }
    } catch (error) {
      safeLogger.error({
        component: "mcp",
        event: "request_failed",
        lambda_request_id: context.awsRequestId,
        status: "INTERNAL_ERROR",
        sanitized_error_class: sanitizedErrorClass(error),
      });
      return jsonResponse(500, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "Internal server error" },
      });
    }
  };
}

export const handler = createHandler();

export { protectedResourceMetadataUrl };
