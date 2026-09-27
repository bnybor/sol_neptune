import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose";

import {
  TokenValidationError,
  verifyAccessTokenWithKey,
} from "../src/mcp/auth.js";
import type { McpConfig } from "../src/mcp/config.js";

const config: McpConfig = {
  enabled: true,
  executorFunctionName: "executor",
  canonicalMcpUrl: "https://test.lambda-url.us-east-1.on.aws/mcp",
  oauthIssuer: "https://issuer.example/",
  allowedSubject: "auth0|robyn-immutable-subject",
  serviceVersion: "1.0.0",
};

describe("OAuth token verification", () => {
  let privateKey: CryptoKey;
  let alternatePrivateKey: CryptoKey;
  let getKey: JWTVerifyGetKey;

  beforeAll(async () => {
    const primary = await generateKeyPair("RS256", { extractable: true });
    const alternate = await generateKeyPair("RS256", { extractable: true });
    privateKey = primary.privateKey;
    alternatePrivateKey = alternate.privateKey;
    const jwk = await exportJWK(primary.publicKey);
    getKey = createLocalJWKSet({
      keys: [{ ...jwk, kid: "primary", alg: "RS256" }],
    });
  });

  async function token(
    claims: Record<string, unknown> = {},
    signingKey: CryptoKey = privateKey,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT({
      scope: "graph:execute",
      ...claims,
    })
      .setProtectedHeader({
        alg: "RS256",
        kid: signingKey === privateKey ? "primary" : "other",
      })
      .setIssuer((claims.iss as string | undefined) ?? config.oauthIssuer)
      .setSubject((claims.sub as string | undefined) ?? config.allowedSubject)
      .setAudience((claims.aud as string | undefined) ?? config.canonicalMcpUrl)
      .setIssuedAt(now)
      .setExpirationTime((claims.exp as number | undefined) ?? now + 300);

    if (typeof claims.nbf === "number") {
      jwt.setNotBefore(claims.nbf);
    }
    return jwt.sign(signingKey);
  }

  it("accepts a valid, resource-bound token for the configured subject and scope", async () => {
    const payload = await verifyAccessTokenWithKey(
      await token(),
      config,
      getKey,
    );
    expect(payload.sub).toBe(config.allowedSubject);
  });

  it("accepts an exact resource claim when aud is for another OAuth client", async () => {
    const jwt = await token({
      aud: "chatgpt-client",
      resource: config.canonicalMcpUrl,
    });
    await expect(
      verifyAccessTokenWithKey(jwt, config, getKey),
    ).resolves.toBeDefined();
  });

  it.each([
    ["issuer", { iss: "https://other-issuer.example/" }],
    ["audience/resource", { aud: "https://other.example/mcp" }],
    ["expiry", { exp: Math.floor(Date.now() / 1000) - 30 }],
    ["not-before", { nbf: Math.floor(Date.now() / 1000) + 300 }],
    ["scope", { scope: "graph:read" }],
    ["subject", { sub: "auth0|someone-else" }],
  ])("rejects an invalid %s", async (_name, claims) => {
    await expect(
      verifyAccessTokenWithKey(await token(claims), config, getKey),
    ).rejects.toBeInstanceOf(TokenValidationError);
  });

  it("rejects an invalid signature", async () => {
    await expect(
      verifyAccessTokenWithKey(
        await token({}, alternatePrivateKey),
        config,
        getKey,
      ),
    ).rejects.toBeInstanceOf(TokenValidationError);
  });

  it("classifies a missing required scope for OAuth reauthorization", async () => {
    await expect(
      verifyAccessTokenWithKey(
        await token({ scope: "openid profile" }),
        config,
        getKey,
      ),
    ).rejects.toMatchObject({ oauthError: "insufficient_scope" });
  });
});
