import { randomUUID } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  failure,
  GRAPH_EXECUTE_SCOPE,
  MAX_QUERY_BYTES,
  type ExecutionFailure,
  type ExecutionResponse,
} from "../shared/contracts.js";
import {
  safeLogger,
  sanitizedErrorClass,
  type SafeLogger,
} from "../shared/logging.js";
import { extractBearerToken, type TokenVerifier } from "./auth.js";
import type { McpConfig } from "./config.js";
import { protectedResourceMetadataUrl } from "./config.js";
import {
  ExecutorInvocationError,
  type ExecutorInvoker,
} from "./executor-invoker.js";

export const SERVER_INSTRUCTIONS =
  "This server exposes Sol's private structural graph through Gremlin. Bound potentially large traversals. Operations may mutate data. Never retry an unknown mutation outcome blindly.";

const queryInput = z
  .object({
    query: z.string().min(1).max(65_536),
  })
  .strict();

const securitySchemes = [
  { type: "oauth2", scopes: [GRAPH_EXECUTE_SCOPE] },
] as const;

export const executeGremlinTool = {
  name: "execute_gremlin",
  title: "Execute Gremlin",
  description:
    "Execute a Gremlin query or mutation against Sol's private Neptune graph.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: 65_536,
        description:
          "A Gremlin query or mutation to execute against Sol's Neptune graph.",
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: true,
    required: ["ok"],
    properties: {
      ok: { type: "boolean" },
    },
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  securitySchemes,
  _meta: {
    securitySchemes,
  },
} as const;

type ServerDependencies = {
  authorization: string | undefined;
  config: McpConfig;
  invokeExecutor: ExecutorInvoker;
  logger?: SafeLogger;
  onAuthChallenge?: (challenge: string) => void;
  tokenVerifier: TokenVerifier;
};

function errorToolResult(
  response: ExecutionFailure,
  challenge?: string,
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: `${response.error.code}: ${response.error.message}`,
      },
    ],
    structuredContent: response,
    isError: true,
    ...(challenge ? { _meta: { "mcp/www_authenticate": [challenge] } } : {}),
  };
}

function challengeFor(
  config: McpConfig,
  error: "invalid_token" | "insufficient_scope",
): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(config)}", scope="${GRAPH_EXECUTE_SCOPE}", error="${error}", error_description="Authentication is required to execute Gremlin"`;
}

function asToolResult(response: ExecutionResponse): CallToolResult {
  if (!response.ok) {
    return errorToolResult(response);
  }

  return {
    content: [{ type: "text", text: JSON.stringify(response) }],
    structuredContent: response,
    isError: false,
  };
}

// The low-level SDK Server is intentionally used for this advanced case because
// the current high-level McpServer type cannot emit OpenAI's securitySchemes field.
// eslint-disable-next-line @typescript-eslint/no-deprecated
export function createMcpServer(dependencies: ServerDependencies): Server {
  const logger = dependencies.logger ?? safeLogger;
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const server = new Server(
    {
      name: "sol-neptune-gremlin",
      version: dependencies.config.serviceVersion,
    },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    // The current SDK transport permits OpenAI's securitySchemes extension even
    // though its published TypeScript Tool type has not yet added that field.
    tools: [executeGremlinTool],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const requestId = randomUUID();
    if (request.params.name !== executeGremlinTool.name) {
      return errorToolResult(
        failure(
          "QUERY_INVALID",
          "The requested tool does not exist.",
          requestId,
        ),
      );
    }

    const input = queryInput.safeParse(request.params.arguments);
    if (
      !input.success ||
      Buffer.byteLength(input.data.query, "utf8") > MAX_QUERY_BYTES
    ) {
      return errorToolResult(
        failure(
          "QUERY_INVALID",
          "The Gremlin query input is invalid.",
          requestId,
        ),
      );
    }

    const token = extractBearerToken(dependencies.authorization);
    if (!token) {
      const challenge = challengeFor(dependencies.config, "invalid_token");
      dependencies.onAuthChallenge?.(challenge);
      return errorToolResult(
        failure(
          "AUTH_REQUIRED",
          "A valid OAuth access token is required.",
          requestId,
        ),
        challenge,
      );
    }

    try {
      await dependencies.tokenVerifier(token);
    } catch {
      const challenge = challengeFor(dependencies.config, "invalid_token");
      dependencies.onAuthChallenge?.(challenge);
      return errorToolResult(
        failure(
          "AUTH_INVALID",
          "The OAuth access token is invalid.",
          requestId,
        ),
        challenge,
      );
    }

    try {
      const response = await dependencies.invokeExecutor(
        input.data.query,
        requestId,
      );
      return asToolResult(response);
    } catch (error) {
      const response = failure(
        error instanceof ExecutorInvocationError && error.definitelyNotInvoked
          ? "NEPTUNE_UNAVAILABLE"
          : "UNKNOWN_MUTATION_OUTCOME",
        error instanceof ExecutorInvocationError && error.definitelyNotInvoked
          ? "The private executor is unavailable."
          : "The executor response was lost after execution may have started; do not retry blindly.",
        requestId,
      );
      logger.error({
        component: "mcp",
        event: "executor_invocation_failed",
        request_id: requestId,
        status: response.error.code,
        sanitized_error_class: sanitizedErrorClass(error),
      });
      return errorToolResult(response);
    }
  });

  return server;
}
