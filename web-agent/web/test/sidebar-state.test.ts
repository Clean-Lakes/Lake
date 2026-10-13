import test from "node:test";
import assert from "node:assert/strict";
import type {Catalog, WorkSession} from "../../shared/contracts";
import {initialSidebarProject, sidebarSessions} from "../src/sidebarState";

const sessions = Array.from({length: 8}, (_, index) => ({id: `s${index}`, projectId: index === 7 ? "older" : "current", updatedAt: `2026-10-${String(20-index).padStart(2,"0")}`} as WorkSession));

test("initial sidebar expands the selected project rather than every project", () => {
  const catalog = {projects: [{id: "current"}, {id: "older"}], sessions, resources: [{id:"host", projectId:"older"}]} as Catalog;
  assert.equal(initialSidebarProject(catalog, {sessionId:"s7", resourceId:null}), "older");
  assert.equal(initialSidebarProject(catalog, {sessionId:null, resourceId:null}), "current");
  assert.equal(initialSidebarProject(catalog, {sessionId:"s0", resourceId:"host"}), "older");
  assert.equal(initialSidebarProject({...catalog, sessions:[], resources:[]}, {sessionId:null, resourceId:null}), "current");
});

test("short sidebar retains an older selected chat while bounding the visible list", () => {
  assert.deepEqual(sidebarSessions(sessions, "s7", false).map(s => s.id), ["s0","s1","s2","s3","s7"]);
  assert.deepEqual(sidebarSessions(sessions, "s1", false).map(s => s.id), ["s0","s1","s2","s3","s4"]);
  assert.equal(sessions.length, 8);
});

test("show-all and short histories retain every conversation", () => {
  assert.equal(sidebarSessions(sessions, "s7", true), sessions);
  const short = sessions.slice(0,3);
  assert.equal(sidebarSessions(short, "s0", false), short);
});
