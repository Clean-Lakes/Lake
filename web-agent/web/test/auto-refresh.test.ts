import assert from "node:assert/strict";
import test from "node:test";
import {startAutoRefresh, type RefreshEnvironment} from "../src/autoRefresh";

function environment() {
  let visible = true;
  let tick = () => {};
  let wake = () => {};
  const runtime: RefreshEnvironment = {
    visible: () => visible,
    every: (callback, milliseconds) => { assert.equal(milliseconds,2000); tick=callback; return () => { tick=() => {}; }; },
    wake: callback => { wake=callback; return () => { wake=() => {}; }; },
  };
  return {runtime, tick: () => tick(), wake: () => wake(), hide: () => { visible=false; }, show: () => { visible=true; }};
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value:T) => void;
  const promise = new Promise<T>(done => { resolve=done; });
  return {promise,resolve};
}

test("model updates arrive without opening a menu; background tabs resume on focus/visibility",async () => {
  const env=environment();
  let model="old";
  const seen:string[]=[];
  const refresh=startAutoRefresh(async () => model, value => seen.push(value), env.runtime);
  await flush();
  model="new";env.tick();await flush();
  assert.deepEqual(seen,["old","new"]);
  env.hide();model="background";env.tick();env.wake();await flush();
  assert.deepEqual(seen,["old","new"]);
  env.show();env.wake();await flush();
  assert.equal(seen.at(-1),"background");
  refresh.stop();env.tick();env.wake();await flush();
  assert.equal(seen.length,3);
});

test("slow polls do not overlap and an old response cannot overwrite an explicit refresh",async () => {
  const env=environment();
  const old=deferred<string>();
  let calls=0;
  let oldSignal:AbortSignal|undefined;
  const seen:string[]=[];
  const refresh=startAutoRefresh(async signal => {
    if (++calls===1) { oldSignal=signal;return old.promise; }
    return "selected";
  },value => seen.push(value),env.runtime);
  env.tick();env.wake();assert.equal(calls,1);
  await refresh.refresh();assert.equal(oldSignal?.aborted,true);
  old.resolve("stale");await flush();
  assert.deepEqual(seen,["selected"]);
  refresh.stop();
});

test("temporary failures retry automatically; disposing suppresses a response that ignores abort",async () => {
  const env=environment();
  const late=deferred<string>();
  const seen:string[]=[];
  let calls=0,errors=0;
  const refresh=startAutoRefresh(async () => {
    if (++calls===1) throw new Error("offline");
    if (calls===2) return "recovered";
    return late.promise;
  },value => seen.push(value),env.runtime,() => {errors++;});
  await flush();env.tick();await flush();
  assert.equal(errors,1);assert.deepEqual(seen,["recovered"]);
  env.tick();refresh.stop();late.resolve("disposed");await flush();
  assert.deepEqual(seen,["recovered"]);
});
