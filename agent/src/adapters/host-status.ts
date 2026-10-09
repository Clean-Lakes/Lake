import {
  cpus,
  freemem,
  totalmem,
  loadavg,
  uptime,
  hostname,
  platform,
  release,
  arch,
} from "node:os";
import { statfs, realpath } from "node:fs/promises";
import type { Resource } from "../domain/entities.js";
import { requireCondition } from "../domain/errors.js";
function cpuTimes() {
  return cpus().reduce(
    (sum, cpu) => ({
      idle: sum.idle + cpu.times.idle,
      total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
    }),
    { idle: 0, total: 0 },
  );
}
export async function hostStatus(resource: Resource, signal: AbortSignal) {
  requireCondition(resource.kind === "local", "scope_denied");
  signal.throwIfAborted();
  const root = await realpath(resource.endpoint),
    disk = await statfs(root),
    before = cpuTimes(),
    start = performance.now();
  await new Promise<void>((done, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      done();
    }, 150);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  const after = cpuTimes(),
    delta = after.total - before.total,
    total = totalmem(),
    free = freemem();
  signal.throwIfAborted();
  return {
    source: "local-system-status",
    observedAt: new Date().toISOString(),
    host: {
      hostname: hostname(),
      platform: platform(),
      release: release(),
      arch: arch(),
    },
    cpu: {
      logicalCores: cpus().length,
      usagePercent:
        delta > 0
          ? Math.round((1 - (after.idle - before.idle) / delta) * 10000) / 100
          : null,
      sampleMs: Math.round(performance.now() - start),
      loadAverage: loadavg(),
    },
    memory: {
      totalBytes: total,
      freeBytes: free,
      usedBytes: total - free,
      measurement:
        "OS-reported total/free counters; cache accounting varies by OS. Do not infer memory pressure from free alone.",
    },
    disk: {
      path: root,
      totalBytes: disk.blocks * disk.bsize,
      availableBytes: disk.bavail * disk.bsize,
      usedPercent:
        disk.blocks > 0
          ? Math.round((1 - disk.bfree / disk.blocks) * 10000) / 100
          : null,
    },
    uptimeSeconds: uptime(),
  };
}
