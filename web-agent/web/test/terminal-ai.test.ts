import test from "node:test";
import assert from "node:assert/strict";
import { sameTerminalBinding,terminalTurnActive,uniqueTerminalRows } from "../src/terminalAIState";
test("scope history may persist while stale terminal results must be rejected",()=>{
 const original={sessionId:"scope",terminalId:"first",generation:"one"};
 assert.equal(sameTerminalBinding(original,{...original,terminalId:"second"}),false);
 assert.equal(sameTerminalBinding(original,{...original,generation:"two"}),false);
 assert.equal(sameTerminalBinding(original,{...original,sessionId:"other-resource"}),false);
 assert.equal(sameTerminalBinding(original,{...original}),true);
});
test("approval and running turns prevent target switching and new submission",()=>{
 assert.equal(terminalTurnActive("running"),true);assert.equal(terminalTurnActive("waiting_approval"),true);assert.equal(terminalTurnActive("cancelled"),false);
});

test("an adopted terminal and its catalog row count as one physical terminal",()=>{const rows=uniqueTerminalRows([{id:"physical",sessionId:"owner",status:"ready"},{id:"physical",sessionId:"owner",status:"busy"},{id:"other",sessionId:"owner",status:"ready"}]);assert.equal(rows.length,2);assert.equal(rows[0]!.sessionId,"owner");assert.equal(rows[0]!.status,"busy")});
