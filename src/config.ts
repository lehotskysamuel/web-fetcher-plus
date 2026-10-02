import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";

export interface Config {
  urlSecret: string;
  /** Still accepted during rotation; unset outside a rotation. */
  urlSecretPrevious?: string;
  brightdataApiKey: string;
  brightdataZone: string;
}

/** Thrown when a required parameter is missing. The message names the parameter, never a value. */
export class ConfigError extends Error {}

const TTL_MS = 5 * 60 * 1000;

const PARAMS = {
  urlSecret: { name: "url-secret", required: true },
  urlSecretPrevious: { name: "url-secret-previous", required: false },
  brightdataApiKey: { name: "brightdata-api-key", required: true },
  brightdataZone: { name: "brightdata-zone", required: true },
} as const;

const ssm = new SSMClient({});
let cached: { config: Config; expiresAt: number } | undefined;
let inflight: Promise<Config> | undefined;

/** Loads the parameters under SSM_PREFIX, cached in memory for 5 minutes. Failed loads are not cached. */
export async function getConfig(): Promise<Config> {
  if (cached && Date.now() < cached.expiresAt) return cached.config;
  inflight ??= load().finally(() => {
    inflight = undefined;
  });
  return inflight;
}

async function load(): Promise<Config> {
  const prefix = process.env.SSM_PREFIX;
  if (!prefix) throw new ConfigError("SSM_PREFIX is not set");

  const names = Object.values(PARAMS).map((p) => prefix + p.name);
  const { Parameters = [] } = await ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
  const values = new Map(Parameters.map((p) => [p.Name, p.Value]));

  const config: Record<string, string | undefined> = {};
  for (const [key, { name, required }] of Object.entries(PARAMS)) {
    const value = values.get(prefix + name) || undefined;
    if (required && !value) throw new ConfigError(`missing SSM parameter ${prefix + name}`);
    config[key] = value;
  }

  cached = { config: config as unknown as Config, expiresAt: Date.now() + TTL_MS };
  return cached.config;
}

/** Test helper: forget the cached config. */
export function resetConfigCache() {
  cached = undefined;
}
