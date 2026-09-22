import {
  NeptunedataClient,
  type NeptunedataClientConfig,
} from "@aws-sdk/client-neptunedata";
import { NodeHttpHandler } from "@smithy/node-http-handler";

export type NeptuneSender = Pick<NeptunedataClient, "send">;

let cachedClient: NeptuneSender | undefined;

export function neptuneClientConfig(
  env: NodeJS.ProcessEnv = process.env,
): NeptunedataClientConfig {
  const host = env.NEPTUNE_ENDPOINT;
  const region = env.AWS_REGION;
  const port = env.NEPTUNE_PORT ?? "8182";

  if (!host || !region || !/^\d{1,5}$/.test(port)) {
    throw new Error("Executor configuration is incomplete");
  }

  return {
    endpoint: `https://${host}:${port}`,
    region,
    maxAttempts: 1,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 2_000,
      requestTimeout: 14_000,
    }),
  };
}

export function buildNeptuneClient(
  env: NodeJS.ProcessEnv = process.env,
): NeptuneSender {
  return new NeptunedataClient(neptuneClientConfig(env));
}

export function getNeptuneClient(): NeptuneSender {
  cachedClient ??= buildNeptuneClient();
  return cachedClient;
}

export function resetNeptuneClient(): void {
  cachedClient = undefined;
}
