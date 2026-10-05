import dgram from "node:dgram";
import os from "node:os";

const MULTICAST_GROUP = "239.255.0.1";
const MULTICAST_PORT = 41234;
const BEACON_INTERVAL_MS = 3000;
// Log a summary every minute so I can confirm the beacon is alive
// without scrolling through 3-second tick spam.
const LOG_INTERVAL_MS = 60_000;

interface DiscoveryBeacon {
  readonly stop: () => void;
}

type BeaconLogger = (msg: string, meta?: Record<string, unknown>) => void;

interface DiscoveryPayload {
  readonly service: "nosleep";
  readonly port: number;
  readonly apiKey: string;
}

export function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const addrs = interfaces[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return "127.0.0.1";
}

export function startDiscoveryBeacon(
  port: number,
  apiKeyPrefix: string,
  log?: BeaconLogger,
): DiscoveryBeacon {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

  const payload: DiscoveryPayload = {
    service: "nosleep",
    port,
    apiKey: apiKeyPrefix,
  };

  const message = Buffer.from(JSON.stringify(payload));

  let sentCount = 0;
  let errorCount = 0;
  let lastError: string | null = null;

  const intervalId = setInterval(() => {
    socket.send(message, 0, message.length, MULTICAST_PORT, MULTICAST_GROUP, (err) => {
      if (err) {
        errorCount += 1;
        lastError = err.message;
      } else {
        sentCount += 1;
      }
    });
  }, BEACON_INTERVAL_MS);

  const summaryId = setInterval(() => {
    if (!log) return;
    // Only log when something is wrong — healthy beacon ticks are not
    // newsworthy. If errorCount > 0 or no sends in a full minute, that's
    // an outage worth seeing.
    if (errorCount > 0 || sentCount === 0) {
      log("discovery beacon: 1-minute summary", {
        sent: sentCount,
        errors: errorCount,
        lastError,
        ip: getLocalIp(),
        port,
      });
    }
    sentCount = 0;
    errorCount = 0;
    lastError = null;
  }, LOG_INTERVAL_MS);

  socket.bind(MULTICAST_PORT, () => {
    try {
      socket.addMembership(MULTICAST_GROUP);
      log?.("discovery beacon: bound + joined multicast group", {
        port: MULTICAST_PORT,
        group: MULTICAST_GROUP,
      });
    } catch (err) {
      log?.("discovery beacon: multicast join failed (non-fatal)", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return {
    stop(): void {
      clearInterval(intervalId);
      clearInterval(summaryId);
      try {
        socket.close();
      } catch {
        // Socket may already be closed
      }
    },
  };
}
