import assert from "node:assert/strict";
import test from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {AIOperationOutcome, AIView, SessionSnapshot} from "../../shared/contracts";
import {AIControls, AITranscript} from "../src/AIPanel";

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
