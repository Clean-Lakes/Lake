import { performance } from "node:perf_hooks";
import {readFileSync} from 'node:fs';
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { testApplication } from "../test/fixtures/application.js";
import { createHttpServer } from "../src/surfaces/http-server.js";
import { parseSse } from "../src/adapters/model/sse-parser.js";
import { SpecialistScheduler } from "../src/specialists/scheduler.js";
import { ModelLimiter } from "../src/agent/model-limiter.js";

// A fixed-duration local projection load; no production resources or credentials.
const durationMs = Number(process.env.LAKE_BENCH_DURATION_MS ?? 600000);
const h = await testApplication(undefined, false),
  resourceId = randomUUID();
await h.app.importResources({
  resources: [
    {
      id: resourceId,
      lakeId: h.lakeId,
      environmentId: h.environmentId,
      kind: "http",
      name: "Benchmark fixture",
      endpoint: "http://127.0.0.1:1",
      identity: "fixture",
    },
  ],
});
const session = await h.app.createSession({
  lakeId: h.lakeId,
  environmentId: h.environmentId,
  objective: "Local projection benchmark",
  resourceIds: [resourceId],
});
const resource = await h.app.store.get<any>("resources", resourceId),
  terminal = await h.app.sessions.open(session.id, resource, "http-health");
const runs = [];
for (let i = 0; i < 3; i++)
  runs.push(
    await h.app.specialists.spawn(
      session.rootTaskId,
      {
        objective: "Benchmark worker " + i,
        resourceIds: [resourceId],
        stepIds: [],
      },
      randomUUID(),
    ),
  );
const scheduler = new SpecialistScheduler(
  h.app.store,
  async (_run, signal) =>
    new Promise<void>((r) =>
      signal.addEventListener("abort", () => r(), { once: true }),
    ),
);
await scheduler.schedule();
const http = await createHttpServer(h.app),
  abort = new AbortController();
const headers = { Authorization: "Bearer " + http.auth.token };
const initial = await h.app.data.snapshot(session.id);
const updates: number[] = [],
  snapshots: number[] = [];
function residentBytes():number{const value=process.memoryUsage().rss;if(value>0)return value;if(process.platform==='linux'){const match=/^VmRSS:\s+(\d+) kB/m.exec(readFileSync('/proc/self/status','utf8'));if(match)return Number(match[1])*1024;}throw new Error('RSS measurement is unavailable');}
let peakModel = 0,
  activeModel = 0,
  rss = residentBytes();
const model = new ModelLimiter(2).wrap({
  async *stream() {
    activeModel++;
    peakModel = Math.max(peakModel, activeModel);
    await new Promise<void>((r) => setImmediate(r));
    activeModel--;
    yield {
      type: "complete",
      message: { role: "assistant", content: "fixture" },
      usage: null,
    };
  },
});
const stream = (async () => {
  const response = await fetch(
    http.origin +
      `/api/v1/sessions/${session.id}/events?after=${initial.cursor}`,
    { headers, signal: abort.signal },
  );
  for await (const data of parseSse(response.body!)) {
    const event = JSON.parse(data);
    if (event.type === "specialist.state_changed")
      updates.push(Date.now() - Date.parse(event.occurredAt));
  }
})().catch((e) => {
  if (!abort.signal.aborted) throw e;
});
const started = performance.now();
let outputBytes = 0;
try {
  for (let i = 0; i < 1000; i++) {
    const target = started + (i * durationMs) / 1000;
    const delay = target - performance.now();
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    await h.app.state.changeActivity(
      runs[i % 3]!.id,
      i % 2 ? "querying_resource" : "model_call",
    );
    const length =
      i === 999 ? 10485760 - outputBytes : Math.floor(10485760 / 1000);
    const text = "x".repeat(length);
    await h.app.output.appendOutput(terminal.id, text);
    outputBytes += length;
    const began = performance.now();
    const response = await fetch(
      http.origin + `/api/v1/sessions/${session.id}/snapshot`,
      { headers },
    );
    await response.json();
    snapshots.push(performance.now() - began);
    rss = Math.max(rss, residentBytes());
    await Promise.all(
      [0, 1].map(async () => {
        for await (const _ of model.stream({
          messages: [],
          tools: [],
          maxOutputTokens: 1,
          signal: abort.signal,
        })) {
        }
      }),
    );
    if (i % 100 === 99)
      console.log(
        JSON.stringify({
          progress: (i + 1) / 10,
          elapsedSeconds: Math.round((performance.now() - started) / 1000),
        }),
      );
  }
  const remain = durationMs - (performance.now() - started);
  if (remain > 0) await new Promise((r) => setTimeout(r, remain));
  await new Promise((r) => setTimeout(r, 300));
  const percentile = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ??
    Infinity;
  const limits = await Promise.all(
    ["cpu.max", "memory.max"].map((name) =>
      readFile("/sys/fs/cgroup/" + name, "utf8")
        .then((v) => v.trim())
        .catch(() => null),
    ),
  );
  const result = {
    cgroupCpuMax: limits[0],
    cgroupMemoryMax: limits[1],
    schemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    durationMs: performance.now() - started,
    activeSpecialists: scheduler.activeCount,
    peakModelRequests: peakModel,
    businessEvents: 2000,
    terminalBytes: outputBytes,
    snapshotSamples: snapshots.length,
    activitySamples: updates.length,
    snapshotP95Ms: percentile(snapshots),
    activityP95Ms: percentile(updates),
    peakRssMiB: rss / 1048576,
    rssSource:process.memoryUsage().rss>0?'node-process-rss':'linux-proc-status',
  };
  const passed =
    result.durationMs >= 600000 &&
    result.activeSpecialists === 3 &&
    result.peakModelRequests === 2 &&
    result.snapshotP95Ms < 300 &&
    result.activityP95Ms < 500 &&
    result.peakRssMiB > 0 && result.peakRssMiB < 500 &&
    updates.length === 1000;
  await mkdir(new URL("../test-results/", import.meta.url), {
    recursive: true,
  });
  await writeFile(
    new URL("../test-results/benchmark.json", import.meta.url),
    JSON.stringify({ ...result, passed }, null, 2) + "\n",
  );
  console.log(JSON.stringify({ ...result, passed }));
  if (!passed) process.exitCode = 1;
} finally {
  abort.abort();
  await stream;
  scheduler.stop();
  await scheduler.drain();
  await http.close();
  await h.close();
}
