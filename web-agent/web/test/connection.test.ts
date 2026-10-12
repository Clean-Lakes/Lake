import assert from "node:assert/strict";
import test from "node:test";
import { sessionConnection } from "../src/connection";

const healthy = {
  ready: true, sessionId: "one", streamSessionId: "one", streamState: "connected" as const,
  snapshotReady: true, restoring: false, error: "",
};

test("normal initial loading pauses actions without claiming a disconnection", () => {
  assert.deepEqual(sessionConnection({ ...healthy, streamState: "connecting", snapshotReady: false }),
    { connected: false, warning: false });
});
test("switching to a cached session does not inherit the previous session connection or failure", () => {
  assert.deepEqual(sessionConnection({ ...healthy, sessionId: "two", streamState: "disconnected", error: "old failure" }),
    { connected: false, warning: false });
  assert.deepEqual(sessionConnection({ ...healthy, sessionId: "two" }), { connected: false, warning: false });
});
test("suspension and restore keep cached content read-only without a false outage warning", () => {
  assert.deepEqual(sessionConnection({ ...healthy, streamState: "connecting", restoring: true }),
    { connected: false, warning: false });
  assert.deepEqual(sessionConnection({ ...healthy, restoring: true }), { connected: false, warning: false });
});
test("healthy polling is usable while an actual stream or snapshot failure still signals an outage", () => {
  assert.deepEqual(sessionConnection({ ...healthy, streamState: "polling" }), { connected: true, warning: false });
  assert.deepEqual(sessionConnection({ ...healthy, streamState: "disconnected" }), { connected: false, warning: true });
  assert.deepEqual(sessionConnection({ ...healthy, error: "snapshot unavailable" }), { connected: false, warning: true });
});
test("a fresh session without its snapshot never enables commands even if its stream has opened", () => {
  assert.deepEqual(sessionConnection({ ...healthy, snapshotReady: false }), { connected: false, warning: false });
});
import type {SessionSnapshot} from "../../shared/contracts";
import {conversationActive} from "../src/connection";

test("background terminals do not hold a completed conversation's button in Stop mode",()=>{
  const snapshot={ai:{status:"completed"},terminals:[{status:"busy",holder:"agent"}]} as SessionSnapshot;
  assert.equal(conversationActive(snapshot,"completed"),false);
  assert.equal(conversationActive({...snapshot,ai:{...snapshot.ai!,status:"running"}},"investigating"),true);
  assert.equal(conversationActive({...snapshot,ai:{...snapshot.ai!,status:"waiting_approval"}},"waiting_approval"),true);
});
