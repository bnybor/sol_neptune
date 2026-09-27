import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

import { GRAPH_EXECUTE_SCOPE } from "../shared/contracts.js";
import type { McpConfig } from "./config.js";

type DiscoveryDocument = {
  issuer?: unknown;
  jwks_uri?: unknown;
  code_challenge_methods_supported?: unknown;
};

export type TokenVerifier = (token: string) => Promise<JWTPayload>;

export class TokenValidationError extends Error {
  public constructor(
    public readonly oauthError:
      "invalid_token" | "insufficient_scope" = "invalid_token",
  ) {
    super("Access token validation failed");
    this.name = "TokenValidationError";
  }
}

function claimValues(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(/\s+/u).filter(Boolean);
  }

  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }

  return [];
}

export function validateTokenClaims(
  payload: JWTPayload,
  config: McpConfig,
): void {
  const audiences = claimValues(payload.aud);
  const resources = claimValues(payload.resource);
  if (
    !audiences.includes(config.canonicalMcpUrl) &&
    !resources.includes(config.canonicalMcpUrl)
  ) {
    throw new TokenValidationError();
  }

  const scopes = new Set([
    ...claimValues(payload.scope),
    ...claimValues(payload.scp),
  ]);
  if (!scopes.has(GRAPH_EXECUTE_SCOPE)) {
    throw new TokenValidationError("insufficient_scope");
  }

  if (payload.sub !== config.allowedSubject) {
    throw new TokenValidationError();
  }
}

export async function verifyAccessTokenWithKey(
  token: string,
  config: McpConfig,
  getKey: JWTVerifyGetKey,
): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(token, getKey, {
      issuer: config.oauthIssuer,
      requiredClaims: ["exp", "sub"],
    });
    validateTokenClaims(payload, config);
    return payload;
  } catch (error) {
    if (error instanceof TokenValidationError) {
      throw error;
    }
    throw new TokenValidationError();
  }
}

function discoveryUrls(issuer: string): URL[] {
  const base = new URL(issuer.endsWith("/") ? issuer : `${issuer}/`);
  return [
    new URL(".well-known/openid-configuration", base),
    new URL(".well-known/oauth-authorization-server", base),
  ];
}

export function createTokenVerifier(
  config: McpConfig,
  fetchImpl: typeof fetch = fetch,
): TokenVerifier {
  let keyPromise: Promise<JWTVerifyGetKey> | undefined;

  const discoverKey = async (): Promise<JWTVerifyGetKey> => {
    for (const url of discoveryUrls(config.oauthIssuer)) {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) {
        continue;
      }

      const document = (await response.json()) as DiscoveryDocument;
      if (
        document.issuer !== config.oauthIssuer ||
        typeof document.jwks_uri !== "string" ||
        !Array.isArray(document.code_challenge_methods_supported) ||
        !document.code_challenge_methods_supported.includes("S256")
      ) {
        throw new TokenValidationError();
      }

      const jwksUrl = new URL(document.jwks_uri);
      if (jwksUrl.protocol !== "https:") {
        throw new TokenValidationError();
      }

      return createRemoteJWKSet(jwksUrl, {
        cacheMaxAge: 600_000,
        cooldownDuration: 30_000,
        timeoutDuration: 3_000,
      });
    }

    throw new TokenValidationError();
  };

  return async (token) => {
    keyPromise ??= discoverKey().catch((error: unknown) => {
      keyPromise = undefined;
      throw error;
    });
    return verifyAccessTokenWithKey(token, config, await keyPromise);
  };
}

export function extractBearerToken(
  authorization: string | undefined,
): string | undefined {
  const match = authorization?.match(/^Bearer ([^\s]+)$/u);
  return match?.[1];
}
