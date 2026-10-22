import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AICard, SessionSnapshot } from "../../shared/contracts";
import { AITranscript } from "../src/AIPanel";
import { FileChanges } from "../src/FileChanges";
import { lineDelta, summarizeFileChanges } from "../src/file-changes-model";

function diff(id: string, path: string, before: string, after: string, extra: Record<string, unknown> = {}): AICard {
  return { id, type: "diff", title: path, at: `2026-10-11T00:00:0${id}Z`, status: "completed", data: { before, after, existed: true, deleted: false, runtime: "local", ...extra } };
}
test("line counts reflect edits, additions, deletions, repeated lines and EOF changes", () => {
  assert.deepEqual(lineDelta("a\nb\nc\n", "a\nx\nc\nd\n"), { added: 2, removed: 1 });
  assert.deepEqual(lineDelta("", "a\nb\n"), { added: 2, removed: 0 });
  assert.deepEqual(lineDelta("a\nb", ""), { added: 0, removed: 2 });
  assert.deepEqual(lineDelta("a\na\nb\na\n", "a\nb\na\n"), { added: 0, removed: 1 });
  assert.deepEqual(lineDelta("a", "a\n"), { added: 1, removed: 1 });
});
test("repeated edits count one file and the net change, including duplicate history cards", () => {
  const first = diff("1", "/tmp/a", "a\nb\n", "a\nc\n");
  const last = diff("2", "/tmp/a", "a\nc\n", "a\nd\ne\n");
  const summary = summarizeFileChanges([first, last, last]);
  assert.equal(summary.files.length, 1);
  assert.deepEqual(summary.delta, { added: 2, removed: 1 });
  assert.equal(summary.files[0]?.before, "a\nb\n");
  assert.equal(summary.files[0]?.after, "a\nd\ne\n");
  assert.equal(summarizeFileChanges([first, diff("3", "/tmp/a", "a\nc\n", "a\nb\n")]).files.length, 0);
});
test("new and deleted empty files count, while create-then-delete and no-op writes do not", () => {
  assert.equal(summarizeFileChanges([diff("1", "/tmp/empty", "", "", { existed: false })]).files.length, 1);
  assert.equal(summarizeFileChanges([diff("1", "/tmp/empty", "", "", { deleted: true })]).files.length, 1);
  assert.equal(summarizeFileChanges([diff("1", "/tmp/empty", "", "")]).files.length, 0);
  assert.equal(summarizeFileChanges([diff("1", "/tmp/a", "", "new", { existed: false }), diff("2", "/tmp/a", "new", "", { deleted: true })]).files.length, 0);
});
test("identical paths on different resources or containers remain separate", () => {
  const summary = summarizeFileChanges([
    diff("1", "/etc/config", "old\n", "new\n", { runtime: "ssh", assetRef: "host1" }),
    diff("2", "/etc/config", "old\n", "new\n", { runtime: "ssh", assetRef: "host2" }),
    diff("3", "/etc/config", "old\n", "new\n", { runtime: "container", assetRef: "docker", containerId: "one" }),
    diff("4", "/etc/config", "old\n", "new\n", { runtime: "container", assetRef: "docker", containerId: "two" }),
  ]);
  assert.equal(summary.files.length, 4);
  assert.deepEqual(summary.delta, { added: 4, removed: 4 });
});
test("legacy operation targets distinguish hosts, and restore records merge with their writes", () => {
  const operation = (id: string, target: string): AICard => ({ id, type: "operation", title: "write", status: "completed", at: "", data: { arguments: { path: "/tmp/a" }, target } });
  const legacy = (id: string): AICard => ({ id, type: "diff", title: "/tmp/a", status: "completed", at: "", data: { before: "old", after: "new" } });
  assert.equal(summarizeFileChanges([operation("a", "host1"), legacy("1"), operation("b", "host2"), legacy("2")]).files.length, 2);
  assert.equal(summarizeFileChanges([operation("a", "Local machine"), diff("1", "/tmp/a", "old", "new"), diff("2", "/tmp/a", "new", "old")]).files.length, 0);
});
test("failed writes, approvals, malformed diffs and unchanged contents do not produce a badge", () => {
  const cards: AICard[] = [
    { ...diff("1", "/tmp/a", "old", "new"), status: "failed" },
    { id: "approval", type: "operation", title: "write", status: "pending", at: "", data: { before: "old", after: "new" } },
    { ...diff("2", "/tmp/a", "old", "new"), data: { before: 3, after: "new" } },
    diff("3", "/tmp/a", "same", "same"),
  ];
  assert.equal(renderToStaticMarkup(createElement(FileChanges, { cards, resources: [] })), "");
});
test("each user turn renders its own badge after the reply with expandable file details", () => {
  const cards = [diff("1", "/tmp/a", "old\n", "new\n"), { id: "reply1", type: "message", content: "First reply", at: "2026-10-11T00:00:02Z", status: "completed" }, diff("4", "/tmp/a", "new\n", "last\nmore\n"), { id: "reply2", type: "message", content: "Second reply", at: "2026-10-11T00:00:05Z", status: "completed" }];
  const snapshot = { session: { id: "fixture" }, resources: [], messages: [
    { id: "user1", role: "user", text: "First request", createdAt: "2026-10-11T00:00:00Z" },
    { id: "user2", role: "user", text: "Second request", createdAt: "2026-10-11T00:00:03Z" },
  ], actions: [], ai: { cards, cardsOffset: 0, status: "completed" } } as SessionSnapshot;
  const html = renderToStaticMarkup(createElement(AITranscript, { snapshot }));
  assert.equal(html.split('class="file-changes-badge"').length - 1, 2);
  assert.ok(html.indexOf("First reply") < html.indexOf("1 个文件已更改"));
  assert.ok(html.lastIndexOf("1 个文件已更改") > html.indexOf("Second reply"));
  assert.ok(html.includes('aria-label="增加 2 行"'));
  assert.ok(html.includes('class="file-change"'));
  assert.ok(html.includes("变更前"));
  assert.ok(html.includes("变更后"));
});
test("paginated history identifies an incomplete turn instead of claiming full totals", () => {
  const html = renderToStaticMarkup(createElement(FileChanges, { cards: [diff("1", "/tmp/a", "old", "new")], resources: [], partial: true }));
  assert.ok(html.includes("1 个文件已更改（部分记录）"));
});


test('conversation file links and totals wait for the turn end while audit details remain available',()=>{
 const user={id:'u',role:'user',text:'修改配置',createdAt:'2026-10-11T00:00:00Z'};
 const snapshot={session:{id:'s'},messages:[user],actions:[],resources:[],ai:{session:'s',status:'running',cards:[diff('1','/tmp/PLAN.md','old','new')],cardsOffset:0,totalCards:1}} as SessionSnapshot;
 for(const status of ['running','waiting_approval']){
  snapshot.ai!.status=status;
  const live=renderToStaticMarkup(createElement(AITranscript,{snapshot}));
  assert.ok(!live.includes('turn-files')&&!live.includes('本轮文件'));
  const audit=renderToStaticMarkup(createElement(AITranscript,{snapshot,mode:'activity'}));
  assert.ok(audit.includes('turn-files')&&audit.includes('PLAN.md'));
 }
 snapshot.ai!.status='completed';
 snapshot.replyTimings=[{messageId:'u',status:'running',startedAt:user.createdAt,finishedAt:''}];
 assert.ok(!renderToStaticMarkup(createElement(AITranscript,{snapshot})).includes('turn-files'),'wait for the whole turn even if engine completion arrives first');
 for(const status of ['completed','failed','cancelled','interrupted'] as const){
  snapshot.replyTimings=[{messageId:'u',status,startedAt:user.createdAt,finishedAt:'2026-10-11T00:01:00Z'}];
  const ended=renderToStaticMarkup(createElement(AITranscript,{snapshot}));
  assert.ok(ended.includes('turn-files')&&ended.includes('PLAN.md')&&ended.includes('1 个文件已更改'),status);
  assert.ok(!ended.includes('reply-arrival'),'restored history never replays the arrival');
 }
});
