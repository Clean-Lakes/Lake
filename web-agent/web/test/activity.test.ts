import assert from "node:assert/strict";
import test from "node:test";
import { turnProgress, toolActivity } from "../src/activity.ts";
import type { AICard, AIView } from "../../shared/contracts.ts";

const start = "2026-10-11T10:00:00Z";
const view = {status:"running", turnStartedAt:start} as AIView;
const read = {id:"read", type:"operation", title:"read", status:"running", at:"2026-10-11T10:00:01Z", data:{arguments:{path:"/tmp/permissions.go"},target:"Local machine"}} as AICard;
test("file activity shows the actual leaf filename and distinguishes approval", () => {
  assert.equal(toolActivity(read).text, "正在读取 permissions.go");
  assert.equal(toolActivity({...read, title:"delete"}, true).text, "等待授权删除 permissions.go");
});
test("turn progress always provides state for the footer independently of process rows", () => {
  const progress = turnProgress(view, [], start, Date.parse(start)+19000);
  assert.equal(progress.activity?.text,"正在思考");
  assert.equal(progress.elapsed, "19秒");
  assert.equal(turnProgress(view, [], start, Date.parse(start)).activity?.text, "正在思考");
  assert.equal(turnProgress(view, [read], start, Date.parse(start)+19000).activity?.text, "正在读取 permissions.go");
});
test("retained operations from an earlier turn never become current progress", () => {
  const old = {...read, at:"2026-10-11T09:59:00Z", status:"pending"};
  const progress = turnProgress(view, [old, read], start, Date.parse(start)+73000);
  assert.equal(progress.activity?.text, "正在读取 permissions.go");
  assert.equal(progress.elapsed, "1分钟 13秒");
  assert.equal(turnProgress(view, [old], start, Date.parse(start)).activity?.text, "正在思考");
});
test("finishing removes the active action and freezes elapsed time", () => {
  const finished = {...view, status:"completed", turnFinishedAt:"2026-10-11T10:01:13Z"};
  const progress = turnProgress(finished, [read], start, Date.parse(start)+3600000);
  assert.equal(progress.activity, undefined);
  assert.equal(progress.elapsed, "1分钟 13秒");
  assert.equal(turnProgress(finished, [read], "2026-10-11T11:00:00Z", Date.now()).elapsed, undefined);
});
test("missing historical timestamps do not invent a duration; streamed text becomes reply activity", () => {
  assert.equal(turnProgress({status:"completed"} as AIView, [], start, Date.now()).elapsed, undefined);
  const reply = {id:"reply", type:"message", status:"running", content:"Hello", at:"2026-10-11T10:00:02Z"} as AICard;
  assert.equal(turnProgress(view, [{...read,status:"completed"},reply], start, Date.parse(start)+5000).activity?.text, "正在生成回复");
});
test("instant simple replies do not add a redundant zero-second work timer",()=>{
  const finished={...view,status:"completed",turnFinishedAt:start};
  assert.equal(turnProgress(finished,[],start,Date.parse(start)).elapsed,undefined);
});
