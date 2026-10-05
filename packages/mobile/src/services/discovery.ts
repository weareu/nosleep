import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Network from "expo-network";

const STORAGE_KEY = "nosleep_server_config";
const API_KEY_STORAGE_KEY = "nosleep_api_key";
const MANUAL_URL_STORAGE_KEY = "nosleep_manual_server_url";
const SERVER_PORT = 3777;
const HEALTH_TIMEOUT_MS = 1000;
const CACHE_VALIDATE_TIMEOUT_MS = 2000;
const BATCH_SIZE = 30;

/** Optional build-time server URL (e.g. the host's Tailscale IP), probed first.
 * Set EXPO_PUBLIC_NOSLEEP_URL in packages/mobile/.env.local — Expo inlines it. */
function configuredServerUrl(): string | null {
  const raw = process.env.EXPO_PUBLIC_NOSLEEP_URL?.trim();
  return raw ? normalizeServerUrl(raw) : null;
}

export interface ServerConfig {
  readonly apiUrl: string;
  readonly wsUrl: string;
  readonly apiKey: string;
}

export async function checkHealth(baseUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/** Sanitize the stored key. If a user pasted with surrounding whitespace,
 * a trailing newline, or smart quotes, NSURLSession rejects the resulting
 * HTTP header as malformed and every fetch throws "Network request failed"
 * with no other diagnostic. Strip anything that's not a header-safe ASCII
 * token char (rfc7230 tchar). */
function sanitizeKey(raw: string): string {
  return raw.replace(/[^!#$%&'*+\-.0-9A-Za-z^_`|~]/g, "");
}

async function getStoredApiKey(): Promise<string> {
  const key = await AsyncStorage.getItem(API_KEY_STORAGE_KEY).catch(() => null);
  return sanitizeKey(key ?? "");
}

export async function setStoredApiKey(raw: string): Promise<void> {
  await AsyncStorage.setItem(API_KEY_STORAGE_KEY, sanitizeKey(raw));
}

async function getDeviceSubnets(): Promise<string[]> {
  const subnets: string[] = [];
  try {
    const ip = await Network.getIpAddressAsync();
    if (ip) {
      const parts = ip.split(".");
      if (parts.length === 4 && parts[0] !== "0") {
        subnets.push(parts.slice(0, 3).join("."));
      }
    }
  } catch {
    // ignore
  }
  return subnets;
}

async function probeUrls(urls: string[], timeoutMs: number): Promise<string | null> {
  // Race all probes — first healthy one wins
  const result = await Promise.any(
    urls.map((url) =>
      checkHealth(url, timeoutMs).then((ok) => {
        if (ok) return url;
        throw new Error("not found");
      }),
    ),
  ).catch(() => null);
  return result;
}

async function scanSubnet(subnet: string): Promise<string | null> {
  for (let batch = 1; batch <= 254; batch += BATCH_SIZE) {
    const end = Math.min(batch + BATCH_SIZE, 255);
    const promises: Promise<string | null>[] = [];

    for (let i = batch; i < end; i++) {
      const url = `http://${subnet}.${i}:${SERVER_PORT}`;
      promises.push(
        checkHealth(url, HEALTH_TIMEOUT_MS).then((ok) => (ok ? url : null)),
      );
    }

    const results = await Promise.all(promises);
    const found = results.find((r): r is string => r !== null);
    if (found) return found;
  }

  return null;
}

export function toWsUrl(httpUrl: string, apiKey: string): string {
  const base = httpUrl.replace(/^http/, "ws") + "/ws";
  return apiKey ? `${base}?token=${apiKey}` : base;
}

/**
 * Build a ServerConfig from a manual URL without any health checks.
 * When a user explicitly sets a URL, trust it immediately.
 */
export async function buildConfigFromManualUrl(url: string): Promise<ServerConfig> {
  const apiKey = await getStoredApiKey();
  const config: ServerConfig = {
    apiUrl: url,
    wsUrl: toWsUrl(url, apiKey),
    apiKey,
  };
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(config)).catch(() => {});
  return config;
}

export async function discoverServer(): Promise<ServerConfig | null> {
  // 0. If manual URL is set, use it directly — no health check.
  //    The user explicitly chose this URL; trust it.
  const manualUrl = await getManualServerUrl();
  if (manualUrl) {
    return buildConfigFromManualUrl(manualUrl);
  }

  // 1. Try cached config
  const cachedJson = await AsyncStorage.getItem(STORAGE_KEY).catch(() => null);
  if (cachedJson) {
    try {
      const cached = JSON.parse(cachedJson) as ServerConfig;
      const isAlive = await checkHealth(cached.apiUrl, CACHE_VALIDATE_TIMEOUT_MS);
      if (isAlive) return cached;
    } catch {
      // invalid cache
    }
    await AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
  }

  // 2. Quick probe: configured URL + common local IPs (all in parallel, ~2s max)
  const configured = configuredServerUrl();
  const quickProbes = [
    ...(configured ? [configured] : []),
    `http://localhost:${SERVER_PORT}`,
  ];

  // Add the gateway (.1) and a few common DHCP addresses for a fast check
  const subnets = await getDeviceSubnets();
  for (const subnet of subnets) {
    quickProbes.push(`http://${subnet}.1:${SERVER_PORT}`);
    // Common DHCP-assigned addresses
    for (const lastOctet of [2, 10, 100, 200]) {
      quickProbes.push(`http://${subnet}.${lastOctet}:${SERVER_PORT}`);
    }
  }

  let found = await probeUrls(quickProbes, CACHE_VALIDATE_TIMEOUT_MS);

  // 3. Full subnet scan as last resort
  if (!found) {
    for (const subnet of subnets) {
      found = await scanSubnet(subnet);
      if (found) break;
    }
  }

  if (!found) return null;

  // 4. Use locally stored API key (configured manually by user in settings)
  const apiKey = await getStoredApiKey();

  const config: ServerConfig = {
    apiUrl: found,
    wsUrl: toWsUrl(found, apiKey),
    apiKey,
  };

  // Cache the config
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(config)).catch(() => {});

  return config;
}

export async function clearCachedServer(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
}

/**
 * Save the API key for authenticating with the NoSleep server.
 * Must be configured manually by the user (not auto-discovered for security).
 * Sanitizes the value to header-safe ASCII so paste cruft (newlines,
 * smart quotes, surrounding whitespace) doesn't turn every later fetch
 * into a generic "Network request failed".
 */
export async function saveApiKey(apiKey: string): Promise<void> {
  await setStoredApiKey(apiKey);
  // Clear cached config so next discovery picks up the new key
  await clearCachedServer();
}

/**
 * Get the currently stored API key.
 */
export async function getApiKey(): Promise<string> {
  return getStoredApiKey();
}

/**
 * Save a manual server URL (e.g. Tailscale IP).
 * Takes highest priority in discovery — set to empty string to disable.
 */
/**
 * Normalize a user-entered server address into a full URL.
 * Accepts: "100.1.2.3", "100.1.2.3:3777", "http://100.1.2.3", "http://100.1.2.3:3777"
 * Always returns "http://<host>:<port>" or empty string.
 */
export function normalizeServerUrl(raw: string): string {
  let val = raw.trim().replace(/\/+$/, "");
  if (!val) return "";
  // Add protocol if missing
  if (!/^https?:\/\//i.test(val)) {
    val = `http://${val}`;
  }
  // Add port if missing
  try {
    const parsed = new URL(val);
    if (!parsed.port) {
      parsed.port = String(SERVER_PORT);
    }
    // Reconstruct clean URL without trailing slash
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
  } catch {
    // URL parse failed — try simple approach
    if (!/:(\d+)$/.test(val)) {
      val = `${val}:${SERVER_PORT}`;
    }
    return val;
  }
}

export async function saveManualServerUrl(url: string): Promise<void> {
  const normalized = normalizeServerUrl(url);
  if (normalized) {
    await AsyncStorage.setItem(MANUAL_URL_STORAGE_KEY, normalized);
  } else {
    await AsyncStorage.removeItem(MANUAL_URL_STORAGE_KEY);
  }
  await clearCachedServer();
}

/**
 * Get the manually configured server URL, if any.
 */
export async function getManualServerUrl(): Promise<string | null> {
  const url = await AsyncStorage.getItem(MANUAL_URL_STORAGE_KEY).catch(() => null);
  return url || null;
}
