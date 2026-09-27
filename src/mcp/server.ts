import { createHash, randomUUID } from "node:crypto";

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
import {
  extractBearerToken,
  TokenValidationError,
  type TokenVerifier,
} from "./auth.js";
import type { McpConfig } from "./config.js";
import { protectedResourceMetadataUrl } from "./config.js";
import {
  ExecutorInvocationError,
  type ExecutorInvoker,
} from "./executor-invoker.js";
import {
  validateGremlinForTool,
  type GremlinToolMode,
} from "./gremlin-safety.js";
import {
  commitSemanticDeltaInputJsonSchema,
  commitSemanticDeltaInputSchema,
  getGraphStateInputJsonSchema,
  getGraphStateInputSchema,
  reconcileOperationInputJsonSchema,
  reconcileOperationInputSchema,
  semanticOperationOutputJsonSchema,
  type SemanticError,
} from "./semantic-contracts.js";
import {
  createGremlinSemanticBackend,
  createSemanticOperations,
  type SemanticOperations,
} from "./semantic-operations.js";

export const SERVER_INSTRUCTIONS =
  "This server exposes Sol's private structural graph through typed semantic operations and separate read, non-destructive write, and destructive-delete Gremlin tools. Prefer guarded typed operations for routine semantic persistence. Use read_gremlin for bounded reads, write_gremlin only for explicitly requested additions or updates, and delete_gremlin only for explicitly requested removals. Never retry an unknown mutation outcome blindly.";

const queryInput = z
  .object({
    query: z.string().min(1).max(65_536),
  })
  .strict();

const profileInput = z.object({}).strict();

const securitySchemes = [
  { type: "oauth2", scopes: [GRAPH_EXECUTE_SCOPE] },
] as const;

const gremlinInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 65_536,
      description:
        "A Gremlin traversal to execute against Sol's Neptune graph.",
    },
  },
} as const;

const gremlinOutputSchema = {
  type: "object",
  additionalProperties: true,
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
  },
} as const;

export const readGremlinTool = {
  name: "read_gremlin",
  title: "Read Gremlin",
  description:
    "Use this for bounded, read-only Gremlin traversals against Sol's private Neptune graph. This action cannot mutate the graph: the server rejects every traversal it cannot verify as non-mutating.",
  inputSchema: gremlinInputSchema,
  outputSchema: gremlinOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  securitySchemes,
  _meta: {
    securitySchemes,
  },
} as const;

export const writeGremlinTool = {
  name: "write_gremlin",
  title: "Write Gremlin",
  description:
    "Use this only for explicitly requested Gremlin mutations that add or update vertices, edges, or properties in Sol's private Neptune graph. The server rejects removals and every traversal it cannot verify as an allowed non-destructive mutation.",
  inputSchema: gremlinInputSchema,
  outputSchema: gremlinOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  securitySchemes,
  _meta: {
    securitySchemes,
  },
} as const;

export const deleteGremlinTool = {
  name: "delete_gremlin",
  title: "Delete with Gremlin",
  description:
    "Use this only for explicitly requested destructive Gremlin mutations that remove vertices, edges, or properties from Sol's private Neptune graph. The server requires a recognized removal step and rejects every traversal it cannot classify safely.",
  inputSchema: gremlinInputSchema,
  outputSchema: gremlinOutputSchema,
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

export const getProfileTool = {
  name: "get_profile",
  title: "Get connected profile",
  description:
    "Return the stable opaque profile represented by the authenticated connection.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  outputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: {
        type: "string",
        minLength: 1,
        pattern: "\\S",
        description:
          "Opaque profile identifier that remains stable across reconnections.",
      },
      name: { type: "string", description: "Profile display name." },
      email: { type: "string", description: "Profile display email." },
      nickname: {
        type: "string",
        description: "Label for distinguishing this connected profile.",
      },
    },
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  securitySchemes,
  _meta: {
    securitySchemes,
    "openai/profile": true,
  },
} as const;

export const getGraphStateTool = {
  name: "get_graph_state",
  title: "Get graph state",
  description:
    "Read the coherent bounded authority, revision, allocator, and optional version-1 control state needed to prepare a guarded semantic operation. This tool never mutates the graph.",
  inputSchema: getGraphStateInputJsonSchema,
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "primary_store",
      "authority_epoch",
      "authority_status",
      "semantic_revision",
      "graph_revision",
      "projection_revision",
      "major_version",
    ],
    properties: {
      primary_store: { type: "string", enum: ["neptune"] },
      authority_epoch: { type: "string" },
      authority_status: { type: "string" },
      semantic_revision: { type: "integer" },
      graph_revision: { type: "integer" },
      projection_revision: { type: "integer" },
      control_revision: { type: "integer" },
      major_version: { type: "integer" },
      allocators: { type: "object", additionalProperties: { type: "string" } },
      v1: { type: "object", additionalProperties: true },
    },
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  securitySchemes,
  _meta: { securitySchemes },
} as const;

export const commitSemanticDeltaTool = {
  name: "commit_semantic_delta",
  title: "Commit semantic delta",
  description:
    "Commit one caller-resolved major-version-0 semantic delta with authority and revision fencing, operation-id idempotency, durable ID allocation, exact readback, and no destructive removal.",
  inputSchema: commitSemanticDeltaInputJsonSchema,
  outputSchema: semanticOperationOutputJsonSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  securitySchemes,
  _meta: { securitySchemes },
} as const;

export const reconcileOperationTool = {
  name: "reconcile_operation",
  title: "Reconcile semantic operation",
  description:
    "Inspect and, when safe, continue the deterministic non-destructive work recorded by an existing typed semantic-operation receipt. This tool never invents a replacement semantic request.",
  inputSchema: reconcileOperationInputJsonSchema,
  outputSchema: semanticOperationOutputJsonSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  securitySchemes,
  _meta: { securitySchemes },
} as const;

type ServerDependencies = {
  authorization: string | undefined;
  config: McpConfig;
  invokeExecutor: ExecutorInvoker;
  logger?: SafeLogger;
  onAuthChallenge?: (challenge: string) => void;
  semanticOperations?: SemanticOperations;
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
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(config)}", scope="${GRAPH_EXECUTE_SCOPE}", error="${error}", error_description="Authentication is required to access the private MCP tools"`;
}

function profileResult(subject: string): CallToolResult {
  const id = `sol_${createHash("sha256")
    .update("sol-neptune-profile\0", "utf8")
    .update(subject, "utf8")
    .digest("base64url")}`;
  const profile = { id, nickname: "Sol Neptune owner" };
  return {
    content: [{ type: "text", text: JSON.stringify(profile) }],
    structuredContent: profile,
    isError: false,
  };
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

function semanticToolResult(
  response: Record<string, unknown> | SemanticError,
): CallToolResult {
  const failed = response.ok === false;
  return {
    content: [{ type: "text", text: JSON.stringify(response) }],
    structuredContent: response,
    isError: failed,
  };
}

function semanticValidationResult(message: string): CallToolResult {
  return semanticToolResult({
    ok: false,
    error: {
      code: "VALIDATION_ERROR",
      message,
      retry_safe: false,
    },
  });
}

function gremlinToolMode(name: string): GremlinToolMode | undefined {
  if (name === readGremlinTool.name) return "read";
  if (name === writeGremlinTool.name) return "write";
  if (name === deleteGremlinTool.name) return "delete";
  return undefined;
}

function invalidGremlinMessage(
  mode: GremlinToolMode,
  unsupportedSyntax: boolean,
): string {
  if (unsupportedSyntax) {
    return "The Gremlin traversal uses syntax or steps that the server cannot classify safely.";
  }
  if (mode === "read") {
    return "The read_gremlin tool only accepts traversals verified as read-only.";
  }
  if (mode === "write") {
    return "The write_gremlin tool only accepts verified add or update traversals and rejects reads and removals.";
  }
  return "The delete_gremlin tool only accepts verified traversals containing a removal step.";
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
    tools: [
      readGremlinTool,
      writeGremlinTool,
      deleteGremlinTool,
      getProfileTool,
      getGraphStateTool,
      commitSemanticDeltaTool,
      reconcileOperationTool,
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const requestId = randomUUID();
    const mode = gremlinToolMode(request.params.name);
    const isGremlin = mode !== undefined;
    const isProfile = request.params.name === getProfileTool.name;
    const isGraphState = request.params.name === getGraphStateTool.name;
    const isSemanticCommit =
      request.params.name === commitSemanticDeltaTool.name;
    const isReconciliation =
      request.params.name === reconcileOperationTool.name;
    if (
      !isGremlin &&
      !isProfile &&
      !isGraphState &&
      !isSemanticCommit &&
      !isReconciliation
    ) {
      return errorToolResult(
        failure(
          "QUERY_INVALID",
          "The requested tool does not exist.",
          requestId,
        ),
      );
    }

    let query: string | undefined;
    let semanticInput: unknown;
    if (isGremlin) {
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
      query = input.data.query;
    } else if (isProfile) {
      if (!profileInput.safeParse(request.params.arguments ?? {}).success) {
        return errorToolResult(
          failure("QUERY_INVALID", "The profile input is invalid.", requestId),
        );
      }
    } else if (isGraphState) {
      const parsed = getGraphStateInputSchema.safeParse(
        request.params.arguments ?? {},
      );
      if (!parsed.success) {
        return semanticValidationResult("The graph-state input is invalid.");
      }
      semanticInput = parsed.data;
    } else if (isSemanticCommit) {
      const parsed = commitSemanticDeltaInputSchema.safeParse(
        request.params.arguments,
      );
      if (!parsed.success) {
        return semanticValidationResult("The semantic delta input is invalid.");
      }
      semanticInput = parsed.data;
    } else if (isReconciliation) {
      const parsed = reconcileOperationInputSchema.safeParse(
        request.params.arguments,
      );
      if (!parsed.success) {
        return semanticValidationResult(
          "The operation-reconciliation input is invalid.",
        );
      }
      semanticInput = parsed.data;
    } else {
      return errorToolResult(
        failure(
          "QUERY_INVALID",
          "The requested tool input is invalid.",
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

    let subject: string;
    try {
      const payload = await dependencies.tokenVerifier(token);
      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new TokenValidationError();
      }
      subject = payload.sub;
    } catch (error) {
      const oauthError =
        error instanceof TokenValidationError
          ? error.oauthError
          : "invalid_token";
      const challenge = challengeFor(dependencies.config, oauthError);
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

    if (isProfile) {
      return profileResult(subject);
    }

    const semanticOperations =
      dependencies.semanticOperations ??
      createSemanticOperations(
        createGremlinSemanticBackend(dependencies.invokeExecutor),
        { logger },
      );
    if (isGraphState) {
      const response = await semanticOperations.getGraphState(
        semanticInput as z.infer<typeof getGraphStateInputSchema>,
        requestId,
      );
      return semanticToolResult(response);
    }
    if (isSemanticCommit) {
      const response = await semanticOperations.commitSemanticDelta(
        semanticInput as z.infer<typeof commitSemanticDeltaInputSchema>,
        requestId,
      );
      return semanticToolResult(response);
    }
    if (isReconciliation) {
      const response = await semanticOperations.reconcileOperation(
        semanticInput as z.infer<typeof reconcileOperationInputSchema>,
        requestId,
      );
      return semanticToolResult(response);
    }

    if (query === undefined || mode === undefined) {
      return errorToolResult(
        failure("QUERY_INVALID", "The Gremlin query is missing.", requestId),
      );
    }

    const validation = validateGremlinForTool(query, mode);
    if (!validation.ok) {
      return errorToolResult(
        failure(
          "QUERY_INVALID",
          invalidGremlinMessage(
            mode,
            validation.reason === "unsupported_syntax",
          ),
          requestId,
        ),
      );
    }

    try {
      const response = await dependencies.invokeExecutor(query, requestId);
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
