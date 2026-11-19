import test from "node:test";
import assert from "node:assert/strict";
import {TaskDeadlineReached,watchTaskDeadline} from "./task-deadline";

test("an execution survives the old 15-minute cap and stops at the absolute task deadline", t => {
  const start=Date.parse("2026-01-01T00:00:00Z");
  t.mock.timers.enable({apis:["Date","setTimeout"],now:start});
  const controller=new AbortController();
  // Lake can dispatch a specialist after some of the original deadline has elapsed.
  const deadline=new Date(start+24*60*60*1000);
  t.mock.timers.tick(4*60*60*1000);
  const stop=watchTaskDeadline(()=>deadline.toISOString(),controller);
  t.mock.timers.tick(16*60*1000);
  assert.equal(controller.signal.aborted,false);
  t.mock.timers.tick(deadline.getTime()-Date.now()-1);
  assert.equal(controller.signal.aborted,false);
  t.mock.timers.tick(1);
  assert.ok(controller.signal.reason instanceof TaskDeadlineReached);
  stop();
});
