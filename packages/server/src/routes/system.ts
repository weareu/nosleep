import type { FastifyInstance } from "fastify";
import os from "node:os";
import { execFile } from "node:child_process";

interface CpuSnapshot {
  idle: number;
  total: number;
}

function getCpuSnapshot(): CpuSnapshot {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
  }
  return { idle, total };
}

function measureCpuUsage(durationMs: number): Promise<number> {
  const before = getCpuSnapshot();
  return new Promise((resolve) => {
    setTimeout(() => {
      const after = getCpuSnapshot();
      const idleDelta = after.idle - before.idle;
      const totalDelta = after.total - before.total;
      const usagePercent = totalDelta === 0 ? 0 : ((totalDelta - idleDelta) / totalDelta) * 100;
      resolve(Math.round(usagePercent * 100) / 100);
    }, durationMs);
  });
}

interface GpuInfo {
  name: string;
  vram: string;
}

let cachedGpuInfo: GpuInfo | null | undefined;

function getGpuInfo(): Promise<GpuInfo | null> {
  if (cachedGpuInfo !== undefined) {
    return Promise.resolve(cachedGpuInfo);
  }

  if (process.platform !== "darwin") {
    cachedGpuInfo = null;
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    execFile(
      "system_profiler",
      ["SPDisplaysDataType", "-json"],
      { timeout: 5000 },
      (error, stdout) => {
        if (error || !stdout) {
          cachedGpuInfo = null;
          resolve(null);
          return;
        }

        try {
          const data = JSON.parse(stdout);
          const displays = data?.SPDisplaysDataType;
          if (!Array.isArray(displays) || displays.length === 0) {
            cachedGpuInfo = null;
            resolve(null);
            return;
          }

          const gpu = displays[0];
          const name: string = gpu.sppci_model ?? gpu._name ?? "Unknown GPU";
          const vram: string =
            gpu.sppci_vram ?? gpu.spdisplays_vram ?? gpu.sppci_vram_shared ?? "Unknown";

          cachedGpuInfo = { name, vram };
          resolve(cachedGpuInfo);
        } catch {
          cachedGpuInfo = null;
          resolve(null);
        }
      },
    );
  });
}

export function registerSystemRoutes(fastify: FastifyInstance): void {
  fastify.get("/api/system/stats", async () => {
    const [usagePercent, gpu] = await Promise.all([
      measureCpuUsage(500),
      getGpuInfo(),
    ]);

    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const loadAvg = os.loadavg() as [number, number, number];

    return {
      success: true,
      data: {
        cpu: {
          usagePercent,
          cores: cpus.length,
          model: cpus[0]?.model ?? "Unknown",
          loadAvg,
        },
        memory: {
          totalBytes: totalMem,
          usedBytes: usedMem,
          freeBytes: freeMem,
          usagePercent: Math.round((usedMem / totalMem) * 10000) / 100,
        },
        gpu,
        uptime: {
          system: Math.floor(os.uptime()),
          server: Math.floor(process.uptime()),
        },
      },
    };
  });
}
