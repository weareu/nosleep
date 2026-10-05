// Configuration for NoSleep mobile app
// Server URLs are discovered automatically via network scan.
// Falls back to localhost for simulators.

import { discoverServer, clearCachedServer, buildConfigFromManualUrl, getManualServerUrl } from "./services/discovery";

interface ServerConfig {
  readonly apiUrl: string;
  readonly wsUrl: string;
  readonly apiKey: string;
}

// Returned when discovery genuinely fails. discoverServer() already probes
// localhost, so a null result means localhost is unreachable too — returning
// a localhost config here would falsely read as "connected" (empty apiUrl
// makes App show the failed screen). NOT cached, so a later call retries.
const NOT_FOUND_CONFIG: ServerConfig = {
  apiUrl: "",
  wsUrl: "",
  apiKey: "",
};

// Module-level cache so discovery only runs once per app session
let resolvedConfig: ServerConfig | null = null;
let discoveryPromise: Promise<ServerConfig> | null = null;

export async function getServerConfig(): Promise<ServerConfig> {
  if (resolvedConfig) return resolvedConfig;

  if (!discoveryPromise) {
    discoveryPromise = discoverServer().then((config) => {
      if (config) {
        resolvedConfig = config; // cache only a real, reachable server
        return config;
      }
      // Discovery failed — do NOT cache, so the next getServerConfig()
      // (e.g. a Retry, or AppState→active) re-runs discovery and can
      // succeed once the server is reachable again.
      discoveryPromise = null;
      return NOT_FOUND_CONFIG;
    });
  }

  return discoveryPromise;
}

export function getServerConfigSync(): ServerConfig | null {
  return resolvedConfig;
}

export async function resetServerConfig(): Promise<void> {
  resolvedConfig = null;
  discoveryPromise = null;
  await clearCachedServer();
}

/**
 * Set config directly from a manual URL — instant, no discovery.
 * Used by Settings when user saves a server URL.
 */
export async function setServerConfigFromManualUrl(url: string): Promise<ServerConfig> {
  resolvedConfig = null;
  discoveryPromise = null;
  const config = await buildConfigFromManualUrl(url);
  resolvedConfig = config;
  return config;
}
