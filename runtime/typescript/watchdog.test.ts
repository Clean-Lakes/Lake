import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LakeStore } from "./store";
import { TaskWatchdog, type WatchdogReview, type WatchdogSample } from "./watchdog";

const minute = 60_000;
function member(name: string, projectId = "p"): WatchdogSample {
  return {
    projectId,
    workerId: "w" + name,
    sessionId: "s" + name,
    executionId: "e" + name,
    taskId: "joint",
    generation: 1,
    policyHash: "policy",
    controlKey: "input1",
    progressKey: "first",
    eligible: true,
    waiting: false,
    unresolved: false,
    title: "共享任务",
    assignment: "检查本端",
    evidence: ["原操作相同结果"],
    recent: [],
  };
}
async function fixture(t: TestContext, names = ["a"]) {
  const home = await mkdtemp(join(tmpdir(), "lake-watchdog-")),
    data = join(home, "data");
  const store = await LakeStore.open(home, data);
  let time = Date.UTC(2026, 10, 7);
  const workers = names.map((name) => member(name));
  const calls: string[] = [],
    guides: { worker: string; id: string; text: string }[] = [];
  const handlers = {
    review: async (_sample: WatchdogSample, _signal: AbortSignal): Promise<WatchdogReview> => ({
      verdict: "stalled",
      reason: "同一检查一直返回相同的结果。",
    }),
    steer: async (_sample: WatchdogSample, _signal: AbortSignal): Promise<boolean> => true,
  };
  const create = () =>
    new TaskWatchdog(
      store,
      {
        activeWorkerIds: () => workers.map((sample) => sample.workerId),
        snapshot: (key) => workers.find((sample) => sample.workerId === key),
        review: (sample, signal) => {
          calls.push(sample.workerId);
          return handlers.review(sample, signal);
        },
        steer: (sample, id, text, signal) => {
          guides.push({ worker: sample.workerId, id, text });
          return handlers.steer(sample, signal);
        },
      },
      () => time,
    );
  let dog = create();
  t.after(async () => {
    await dog.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    get dog() {
      return dog;
    },
    workers,
    calls,
    guides,
    handlers,
    advance: (n = 1) => {
      time += minute * n;
    },
    async ticks(n: number) {
      for (let i = 0; i < n; i++) {
        time += minute;
        await dog.scan();
      }
    },
    async restart() {
      await dog.close();
      dog = create();
    },
  };
}

test("a sleeping host only samples once; three observed windows trigger one review and observation alone never steers", async (t) => {
  const f = await fixture(t);
  await f.dog.scan();
  f.advance(4);
  await f.dog.scan();
  await f.dog.scan();
  await f.ticks(1);
  assert.deepEqual(f.calls, []);
  await f.ticks(1);
  assert.equal(f.dog.records("p")[0].state, "observed");
  assert.equal(f.dog.records("p")[0].kind, "stall");
  await f.restart();
  await f.ticks(14);
  assert.deepEqual(f.calls, ["wa"]);
  await f.ticks(1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.guides.length, 0);
});

test("joint participants are isolated; waits and unverified effects suppress review; resumed progress is distinct from guide queuing", async (t) => {
  const f = await fixture(t, ["a", "b", "c"]);
  f.workers[0].waiting = true;
  f.workers[2].unresolved = true;
  f.dog.setMode("p", "guide");
  f.handlers.review = async () => ({ verdict: "stalled", reason: "运行 rm -rf 以解决此问题。" });
  await f.dog.scan();
  await f.ticks(3);
  assert.deepEqual(f.calls, ["wb"]);
  assert.equal(f.guides.length, 1);
  assert.equal(f.guides[0].worker, "wb");
  assert.doesNotMatch(f.guides[0].text, /rm -rf/);
  assert.equal(f.dog.records("p", "eb")[0].state, "guided");
  assert.deepEqual(f.dog.records("p", "ea"), []);
  assert.deepEqual(f.dog.records("foreign", "eb"), []);
  f.workers[1].progressKey = "new evidence";
  await f.ticks(1);
  assert.equal(f.dog.records("p", "eb")[0].state, "recovered");
  await f.ticks(15);
  assert.equal(f.guides.length, 1, "same generation and finding was already guided");
});

test("a long-running worker with fresh evidence can still be heading away from its assignment", async (t) => {
  const f = await fixture(t);
  f.dog.setMode("p", "guide");
  f.handlers.review = async () => ({ verdict: "drift", reason: "连续检查的目标与原指派不同。" });
  await f.dog.scan();
  for (let i = 1; i <= 15; i++) {
    f.workers[0].progressKey = "resource-" + i;
    await f.ticks(1);
  }
  assert.equal(f.dog.records("p")[0].kind, "periodic");
  assert.equal(f.dog.records("p")[0].verdict, "drift");
  assert.equal(f.guides.length, 1);
});

for (const changed of [
  "stopped",
  "evidence",
  "waiting",
  "unknown",
  "policy",
  "generation",
  "followup",
  "off_then_guide",
] as const) {
  test("a pending review cannot steer after " + changed, async (t) => {
    const f = await fixture(t);
    f.dog.setMode("p", "guide");
    let deliver!: (value: WatchdogReview) => void;
    f.handlers.review = () =>
      new Promise((resolve) => {
        deliver = resolve;
      });
    await f.dog.scan();
    await f.ticks(2);
    f.advance();
    const review = f.dog.scan();
    const worker = f.workers[0];
    if (changed === "stopped") worker.eligible = false;
    if (changed === "evidence") worker.progressKey = "changed";
    if (changed === "waiting") worker.waiting = true;
    if (changed === "unknown") worker.unresolved = true;
    if (changed === "policy") worker.policyHash = "new";
    if (changed === "generation") worker.generation++;
    if (changed === "followup") worker.controlKey = "input2";
    if (changed === "off_then_guide") {
      f.dog.setMode("p", "off");
      f.dog.setMode("p", "guide");
    }
    deliver({ verdict: "stalled", reason: "旧判断。" });
    await review;
    assert.equal(f.guides.length, 0);
    assert.equal(f.dog.records("p")[0].state, "stale");
  });
}

test("hourly review claims survive restart, charge failures and keep project budgets separate", async (t) => {
  const f = await fixture(t, ["a", "b", "c", "d", "e"]);
  f.workers.push(member("other", "second"));
  f.handlers.review = async () => {
    throw new Error("private failure detail");
  };
  await f.dog.scan();
  await f.ticks(3);
  assert.equal(f.calls.length, 5);
  assert.equal(f.dog.records("p").length, 4);
  assert.equal(f.dog.records("second").length, 1);
  assert.ok(f.dog.records("p").every((r) => r.state === "error" && !r.reason.includes("private")));
  await f.restart();
  await f.ticks(15);
  assert.equal(f.dog.records("p").length, 4);
  assert.equal(f.dog.records("second").length, 2);
});

test("closing an in-flight review releases the scan, retains its charge and never replays its guide", async (t) => {
  const f = await fixture(t);
  f.dog.setMode("p", "guide");
  let signal: AbortSignal | undefined;
  f.handlers.review = (_s, s) => {
    signal = s;
    return new Promise(() => {});
  };
  await f.dog.scan();
  await f.ticks(2);
  f.advance();
  const scan = f.dog.scan();
  await f.restart();
  await scan;
  assert.equal(signal?.aborted, true);
  assert.equal(f.dog.records("p")[0].state, "stale");
  await f.ticks(2);
  assert.equal(f.calls.length, 1);
  assert.equal(f.guides.length, 0);
});

test("an infrastructure retry is a single recorded incident until the host confirms recovery", async (t) => {
  const f = await fixture(t),
    sample = f.workers[0];
  f.dog.recordIncident(sample, "临时网关异常");
  f.dog.recordIncident(sample, "临时网关异常", "retry_queued");
  f.dog.recordIncident(sample, "临时网关异常");
  assert.equal(f.dog.records("p")[0].state, "retry_queued");
  f.dog.recordIncident(sample, "临时网关异常", "recovered");
  f.dog.recordIncident(sample, "临时网关异常", "error");
  assert.deepEqual(
    f.dog.records("p").map((r) => r.state),
    ["recovered"],
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.guides.length, 0);
});

test("the last task turn can finish before the next observation without borrowing another participant's acceptance", async (t) => {
  const f = await fixture(t);
  f.dog.setMode("p", "guide");
  await f.dog.scan();
  await f.ticks(3);
  f.dog.completed({ ...f.workers[0], workerId: "other-member" });
  assert.equal(f.dog.records("p")[0].state, "guided");
  f.dog.completed(f.workers[0]);
  assert.equal(f.dog.records("p")[0].state, "recovered");
});

test("a reviewer that never responds times out and consumes only its original quota", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t);
  f.dog.setMode("p", "guide");
  let signal: AbortSignal | undefined;
  f.handlers.review = (_sample, s) => {
    signal = s;
    return new Promise(() => {});
  };
  await f.dog.scan();
  await f.ticks(2);
  f.advance();
  const pending = f.dog.scan();
  t.mock.timers.tick(30000);
  await pending;
  assert.equal(signal?.aborted, true);
  assert.equal(f.guides.length, 0);
  assert.equal(f.dog.records("p")[0].state, "error");
  await f.ticks(1);
  assert.equal(f.calls.length, 1);
});

test("entering an unresolved state after a guide does not mark that execution as recovered", async (t) => {
  const f = await fixture(t);
  f.dog.setMode("p", "guide");
  await f.dog.scan();
  await f.ticks(3);
  f.workers[0].progressKey = "step-entered-blocked";
  f.workers[0].unresolved = true;
  await f.ticks(1);
  assert.equal(f.dog.records("p")[0].state, "guided");
});

test("returning from a real wait needs new evidence before reporting recovery", async t=>{
  const f=await fixture(t);
  f.dog.setMode("p","guide");
  await f.dog.scan();
  await f.ticks(3);
  f.workers[0].waiting=true;
  f.workers[0].progressKey="";
  await f.ticks(1);
  f.workers[0].waiting=false;
  f.workers[0].progressKey="first";
  await f.ticks(1);
  assert.equal(f.dog.records("p")[0].state,"guided");
  f.workers[0].progressKey="new receipt";
  await f.ticks(1);
  assert.equal(f.dog.records("p")[0].state,"recovered");
});
