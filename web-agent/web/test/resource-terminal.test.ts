import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TerminalSession } from "../../shared/contracts";
import { reusableResourceTerminal, onlineTerminalOptions, panelTerminalSessions, ResourceTerminalConnections } from "../src/resourceTerminalState";
import { TerminalSidePanel } from "../src/TerminalSidePanel";

function terminal(id: string, resourceId: string, status: TerminalSession["status"], createdAt: string): TerminalSession { return { id, resourceId, status, createdAt, interactive: true } as TerminalSession; }

test("reopening reuses a ready terminal, ignores disconnected records and preserves a running one", () => {
  const terminals = [terminal("old", "ssh", "ready", "2026-10-10"), terminal("recent", "ssh", "busy", "2026-10-11"), terminal("closed", "ssh", "disconnected", "2026-10-12"), terminal("local", "local", "ready", "2026-10-13")];
  assert.equal(reusableResourceTerminal(terminals, "ssh")?.id, "old");
  assert.equal(reusableResourceTerminal(terminals.slice(1), "ssh")?.id, "recent");
  assert.equal(reusableResourceTerminal(terminals.slice(2), "ssh"), undefined);
  assert.equal(reusableResourceTerminal([...terminals, terminal("ready-new", "ssh", "ready", "2026-10-14")], "ssh")?.id, "ready-new");
});
test("a closed terminal panel has no focusable contents; an open panel exposes its region and close control", () => {
  const content = createElement("textarea", { "aria-label": "命令输入" });
  const closed = renderToStaticMarkup(createElement(TerminalSidePanel, { open: false, onClose() {}, children: content }));
  assert.ok(closed.includes('inert=""'));
  assert.ok(closed.includes('aria-hidden="true"'));
  assert.ok(!closed.includes("textarea"));
  const open = renderToStaticMarkup(createElement(TerminalSidePanel, { open: true, onClose() {}, children: content }));
  assert.ok(open.includes('aria-label="资源终端"'));
  assert.ok(open.includes('aria-label="收起终端面板"'));
  assert.ok(open.includes("命令输入"));
  assert.ok(!open.includes('inert=""'));
});
test("classic terminal opening reuses interactive shells without selecting a managed Agent console", () => {
  const managed = {...terminal("managed", "ssh", "ready", "2026-10-12"), interactive: false};
  const raw = { ...terminal("interactive", "ssh", "ready", "2026-10-11"), interactive: true };
  assert.equal(reusableResourceTerminal([managed, raw], "ssh", true)?.id, "interactive");
  assert.equal(reusableResourceTerminal([managed], "ssh", true), undefined);
});

test("the terminal picker lists live connections with friendly names and no internal IDs", () => {
  const items = [terminal("uuid-running", "ssh", "busy", "2026-10-12"), terminal("uuid-closed", "ssh", "disconnected", "2026-10-10"), terminal("uuid-ready", "ssh", "ready", "2026-10-11"), terminal("uuid-local", "local", "ready", "2026-10-13")];
  const options = onlineTerminalOptions([...items, items[0]!], id => id === "ssh" ? "测试服务器" : "本机");
  assert.deepEqual(options.map(item => item.terminal.id), ["uuid-ready", "uuid-running", "uuid-local"]);
  assert.deepEqual(options.map(item => item.label), ["测试服务器 · 终端 1", "测试服务器 · 终端 2", "本机 · 终端 1"]);
  assert.ok(options.every(item => !item.label.includes("uuid")));
  assert.deepEqual(onlineTerminalOptions([items[1]!], () => "测试服务器"), []);
  assert.equal(items[0]?.id, "uuid-running");
});

 test("managed AI shells never appear in the manual terminal picker", () => {
  const raw = terminal("manual", "ssh", "ready", "2026-10-12");
  const background = {...terminal("agent", "ssh", "ready", "2026-10-11"), interactive: false};
  assert.deepEqual(onlineTerminalOptions([background, raw], () => "SSH").map(item => item.terminal.id), ["manual"]);
 });


test("switching hosts retains other hosts and replaces stale rows for the active host", () => {
  const a = {...terminal("a", "host-a", "ready", "2026-10-11"), sessionId: "owner-a"};
  const b = {...terminal("b", "host-b", "ready", "2026-10-12"), sessionId: "owner-b"};
  const busyB = {...b, status: "busy" as const};
  const list = panelTerminalSessions([a, b], [], [busyB], "host-b");
  assert.deepEqual(onlineTerminalOptions(list, id => id).map(option => [option.terminal.id, option.terminal.sessionId, option.terminal.status]), [["a", "owner-a", "ready"], ["b", "owner-b", "busy"]]);
  assert.deepEqual(panelTerminalSessions([a, b], [], [], "host-b"), [a]);
  assert.deepEqual(panelTerminalSessions([a], [a, b], [], undefined), [a, b]);
});


test("a slow host does not block another host or steal the selected terminal on completion", () => {
  const connections = new ResourceTerminalConnections();
  const a = connections.begin("a");
  const b = connections.begin("b");
  assert.equal(a.started, true);
  assert.equal(b.started, true);
  assert.deepEqual(connections.resourceIds(), ["a", "b"]);
  assert.equal(connections.isSelected(a.attempt), false);
  assert.equal(connections.isSelected(b.attempt), true);
  connections.finish(a.attempt);
  assert.deepEqual(connections.resourceIds(), ["b"]);
  assert.equal(connections.isSelected(b.attempt), true);
  connections.selectTerminal();
  assert.equal(connections.isSelected(b.attempt), false);
  connections.finish(b.attempt);
  assert.deepEqual(connections.resourceIds(), []);
});

test("revisiting a connecting host reuses its request and context, and failure permits retry", () => {
  const connections = new ResourceTerminalConnections();
  const a = connections.begin("a");
  a.attempt.context = {sessionId: "owner-a", resourceId: "a"};
  connections.begin("b");
  const revisited = connections.begin("a");
  assert.equal(revisited.started, false);
  assert.equal(revisited.attempt, a.attempt);
  assert.equal(revisited.attempt.context?.sessionId, "owner-a");
  assert.equal(connections.isSelected(a.attempt), true);
  connections.finish(a.attempt);
  const retry = connections.begin("a");
  assert.equal(retry.started, true);
  connections.finish(a.attempt); // An old completion cannot unlock a new request.
  assert.deepEqual(connections.resourceIds(), ["b", "a"]);
});
