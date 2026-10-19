import test from "node:test";
import assert from "node:assert/strict";
import { atConversationTail, conversationCanScroll, pausesConversationFollow, FollowScroll } from "../src/followScroll";
import { sameCard } from "../src/cardEquality";

function fixture(reduced = false) {
  let following = true; let next = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const box = {scrollTop: 0, scrollHeight: 1000, clientHeight: 500};
  const follower = new FollowScroll(box, () => following, {
    request(callback) { callbacks.set(++next, callback); return next; },
    cancel(id) { callbacks.delete(id); },
  }, reduced);
  return {box, follower, callbacks, pause() {following = false;}, frame(time: number) {
    const entries = [...callbacks]; callbacks.clear(); entries.forEach(([, callback]) => callback(time));
  }};
}

test('gestures without room to scroll never strand following; upward reading still pauses',()=>{
 const box={scrollTop:0,scrollHeight:400,clientHeight:500};
 assert.equal(conversationCanScroll(box),false);
 assert.equal(pausesConversationFollow(box,-1),false);
 assert.equal(pausesConversationFollow(box,1),false);
 box.scrollHeight=1000;box.scrollTop=500;
 assert.equal(pausesConversationFollow(box,1),false,'down at tail has no scroll event to resume following');
 assert.equal(pausesConversationFollow(box,-1),true);
 box.scrollTop=200;
 assert.equal(pausesConversationFollow(box,1),true,'manual reading remains in control until reaching tail');
});

test('content crossing from empty space into overflow follows and stops at the new tail',()=>{
 const f=fixture();f.box.scrollHeight=300;
 f.follower.request();assert.equal(f.callbacks.size,0);
 f.box.scrollHeight=900;f.follower.request();
 for(let time=0;time<1500;time+=16.67)f.frame(time);
 assert.equal(f.box.scrollTop,400);assert.equal(f.callbacks.size,0);
});

test("stream and resize requests coalesce, and scroll moves between snapshot arrivals", () => {
  const f = fixture();
  f.follower.request(); f.follower.request(); f.follower.request();
  assert.equal(f.callbacks.size, 1);
  f.frame(0); const first = f.box.scrollTop;
  assert.ok(first > 0 && first < 500);
  f.frame(16.67); assert.ok(f.box.scrollTop > first && f.box.scrollTop < 500);
  f.box.scrollHeight = 1200; f.follower.request();
  for (let time = 33.34; time < 1300; time += 16.67) f.frame(time);
  assert.equal(f.box.scrollTop, 700);
  assert.equal(f.follower.animating, false);
});

test("manual reading cancels follow and session cleanup leaves no animation behind", () => {
  const f = fixture(); f.follower.request(); f.frame(0);
  f.pause(); const position = f.box.scrollTop; f.frame(16.67);
  assert.equal(f.box.scrollTop, position); assert.equal(f.callbacks.size, 0);
  f.follower.request(); assert.equal(f.callbacks.size, 0);
  const other = fixture(); other.follower.request(); other.follower.stop();
  assert.equal(other.callbacks.size, 0);
});

test("reduced motion and initial session placement reach the bottom without animation", () => {
  const f = fixture(true); f.follower.request(); f.frame(0);
  assert.equal(f.box.scrollTop, 500); assert.equal(f.callbacks.size, 0);
  const initial = fixture(); initial.follower.jump();
  assert.equal(initial.box.scrollTop, 500); assert.equal(initial.callbacks.size, 0);
});

test("device-pixel rounding still reaches the exact tail and stops scheduling frames", () => {
  const f = fixture(); let top = 0;
  Object.defineProperty(f.box, "scrollTop", {get: () => top, set: value => {top = Math.round(value);}});
  f.follower.request();
  for (let time = 0; time < 1500; time += 8.33) f.frame(time);
  assert.equal(top, 500); assert.equal(f.callbacks.size, 0);
});

test("activity-only snapshot updates at the tail never schedule frames or write scroll position", () => {
  const f = fixture(); f.follower.jump();
  let writes = 0, top = f.box.scrollTop;
  Object.defineProperty(f.box, "scrollTop", {get: () => top, set: value => {writes++;top=value;}});
  for (let i=0;i<500;i++) f.follower.request();
  assert.equal(f.callbacks.size, 0); assert.equal(writes, 0);
  // Actual new content still follows; the optimization must not suppress it.
  f.box.scrollHeight += 100; f.follower.request();
  for(let time=0;time<1500;time+=16.67)f.frame(time);
  assert.equal(top,600); assert.ok(writes>0);
});

test("fractional browser tail stays still on activity updates and follows actual new content", () => {
  for (const reduced of [false, true]) {
    const f = fixture(reduced); let top = 0, writes = 0;
    // The DOM reports integer heights even when layout clamps to a half pixel.
    Object.defineProperty(f.box, "scrollTop", {get: () => top, set: value => {
      writes++; top = Math.min(value, f.box.scrollHeight - f.box.clientHeight - 0.5);
    }});
    f.follower.jump(); writes = 0;
    for (let i = 0; i < 100; i++) { f.follower.request(); f.frame(i * 16.67); }
    assert.equal(writes, 0); assert.equal(f.callbacks.size, 0); assert.equal(top, 499.5);
    f.box.scrollHeight += 100; f.follower.request();
    for (let time = 0; time < 1500; time += 16.67) f.frame(time);
    assert.ok(writes > 0); assert.equal(top, 599.5); assert.equal(f.callbacks.size, 0);
  }
});

test("reading just above the tail does not resume following until the reader reaches the bottom", () => {
  const box = {scrollTop: 464, scrollHeight: 1000, clientHeight: 500};
  assert.equal(atConversationTail(box), false);
  box.scrollTop = 498;
  assert.equal(atConversationTail(box), false);
  box.scrollTop = 499.5;
  assert.equal(atConversationTail(box), true);
  box.scrollTop = 500;
  assert.equal(atConversationTail(box), true);
  assert.equal(atConversationTail({scrollTop: 0, scrollHeight: 300, clientHeight: 500}), true);
});

test("unchanged historical cards reuse Markdown, while streamed content and tool state invalidate it", () => {
  const card = {id: "reason", type: "thinking", at: "2026-10-11T00:00:00Z", status: "completed", content: "**historical**", data: {target: "fixture", arguments: {command: "stat fixture"}}};
  assert.ok(sameCard(card, JSON.parse(JSON.stringify(card))));
  assert.equal(sameCard(card, {...card, content: "**updated**"}), false);
  assert.equal(sameCard(card, {...card, status: "pending"}), false);
  assert.equal(sameCard(card, {...card, data: {target: "different host"}}), false);
});
