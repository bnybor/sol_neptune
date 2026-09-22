export type McpConfig = {
  enabled: boolean;
  executorFunctionName: string;
  canonicalMcpUrl: string;
  oauthIssuer: string;
  allowedSubject: string;
  serviceVersion: string;
};

export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  return {
    enabled: env.MCP_ENABLED === "true",
    executorFunctionName: env.EXECUTOR_FUNCTION_NAME ?? "",
    canonicalMcpUrl: env.CANONICAL_MCP_URL ?? "",
    oauthIssuer: env.OAUTH_ISSUER ?? "",
    allowedSubject: env.ALLOWED_SUBJECT ?? "",
    serviceVersion: env.SERVICE_VERSION ?? "1.0.0",
  };
}

export function validateEnabledConfig(config: McpConfig): void {
  if (!config.enabled) {
    throw new Error("MCP is disabled");
  }

  if (!config.executorFunctionName || !config.allowedSubject) {
    throw new Error("MCP configuration is incomplete");
  }

  const resource = new URL(config.canonicalMcpUrl);
  if (
    resource.protocol !== "https:" ||
    resource.pathname !== "/mcp" ||
    resource.search !== "" ||
    resource.hash !== "" ||
    resource.toString() !== config.canonicalMcpUrl
  ) {
    throw new Error("The canonical MCP URL must be an exact HTTPS /mcp URL");
  }

  const issuer = new URL(config.oauthIssuer);
  if (
    issuer.protocol !== "https:" ||
    issuer.search !== "" ||
    issuer.hash !== "" ||
    issuer.toString() !== config.oauthIssuer
  ) {
    throw new Error("The OAuth issuer must be an exact HTTPS URL");
  }
}

export function isReady(config: McpConfig): boolean {
  try {
    validateEnabledConfig(config);
    return true;
  } catch {
    return false;
  }
}

export function protectedResourceMetadataUrl(config: McpConfig): string {
  return new URL(
    "/.well-known/oauth-protected-resource",
    config.canonicalMcpUrl,
  ).toString();
}
