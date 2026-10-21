import assert from "node:assert/strict";
import test from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {AIOperationOutcome, AIView, SessionSnapshot} from "../../shared/contracts";
import {AIControls, AITranscript} from "../src/AIPanel";
import {OperationOutcomes} from '../src/OperationOutcomes';

const at = "2026-10-18T00:00:00Z";
const operation = (status: string): AIOperationOutcome => ({id: status, tool: "shell", target: `${status}-host`, status, startedAt: at});
function controls(outcomes: AIOperationOutcome[], status = "running") {
  const snapshot = {session: {id: "fixture"}, ai: {status, operationOutcomes: outcomes}} as SessionSnapshot;
  return renderToStaticMarkup(createElement(AIControls, {snapshot, refresh: async () => {}, optionsOpen: false, onCloseOptions() {}, permissionsOpen: false, permissionAnchor: {current: null}, onClosePermissions() {}})).trim();
}

test("running tools show normal progress without requesting outcome verification", () => {
  assert.equal(controls([operation("dispatched")]), "");
  const view = {session: "fixture", status: "running", turnStartedAt: at, profile: "core", cardsOffset: 0, cards: [{id: "shell", type: "operation", title: "shell", status: "running", at, data: {arguments: {command: "sleep 1"}, target: "fixture-host"}}]} as AIView;
  const snapshot = {session: {id: "fixture"}, messages: [{id: "user", role: "user", createdAt: at, text: "Check fixture"}], actions: [], ai: view} as SessionSnapshot;
  const html = renderToStaticMarkup(createElement(AITranscript, {snapshot}));
  assert.equal((html.match(/turn-status-text/g) || []).length, 1);
  assert.ok(html.includes("正在执行工具…"));
  assert.ok(!html.includes("原操作结果待核实"));
});

test("unknown outcomes never insert an automatic verification panel above the composer", () => {
  for (const status of ["running", "completed", "cancelled", "failed", "interrupted"]) {
    const html = controls([operation("dispatched"), operation("unknown"), operation("succeeded"), operation("failed"), operation("not_executed")], status);
    assert.equal(html, "");
    assert.ok(!html.includes("原操作结果待核实") && !html.includes("填写核实结果"));
  }
});

test('manual verification is scoped to execution records and requires an explicit outcome and evidence', () => {
  const html = renderToStaticMarkup(createElement(OperationOutcomes, {session: 'fixture', operations: [operation('unknown'), operation('dispatched')], running: false, disabled: false}));
  assert.ok(html.includes('待核实操作 · 1'));
  assert.ok(!html.includes('<details open'));
  assert.ok(html.includes('unknown-host') && !html.includes('dispatched-host'));
  assert.ok(html.includes('请选择核实结果') && html.includes('核实依据'));
  assert.match(html, /<button[^>]*disabled=""[^>]*>记录核实结果/);
  assert.ok(!html.includes('重试操作') && !html.includes('放弃原操作'));
  const running = renderToStaticMarkup(createElement(OperationOutcomes, {session: 'fixture', operations: [operation('unknown')], running: true, disabled: false}));
  assert.ok(running.includes('<fieldset disabled=""') && running.includes('请先停止当前运行'));
  const snapshot = {session:{id:'fixture'},messages:[],actions:[],ai:{status:'completed',cards:[],operationOutcomes:[operation('unknown')]}} as unknown as SessionSnapshot;
  const activity = renderToStaticMarkup(createElement(AITranscript, {snapshot, mode:'activity'}));
  const conversation = renderToStaticMarkup(createElement(AITranscript, {snapshot, mode:'conversation'}));
  assert.ok(activity.includes('待核实操作'));
  assert.ok(!conversation.includes('待核实操作'));
});
