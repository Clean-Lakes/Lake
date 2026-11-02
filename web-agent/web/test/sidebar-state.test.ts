import test from "node:test";
import assert from "node:assert/strict";
import type {Catalog, WorkSession} from "../../shared/contracts";
import {initialSidebarProject, initialWorkspaceSelection, sidebarSessions} from "../src/sidebarState";

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

test("reopening restores the chosen project and its session despite newer activity elsewhere", () => {
  const catalog = {projects: [{id:"current"},{id:"older"}],sessions,resources:[]} as unknown as Catalog;
  const selection = initialWorkspaceSelection(catalog,{sessionId:null,resourceId:null},'older');
  assert.deepEqual(selection,{projectId:'older',route:{sessionId:'s7',resourceId:null}});
  assert.equal(initialSidebarProject(catalog,{sessionId:null,resourceId:null},'older'),'older');
});

test("explicit session and resource links take precedence over a saved project", () => {
  const catalog = {projects:[{id:'current'},{id:'older'}],sessions,resources:[{id:'host',projectId:'older'}]} as unknown as Catalog;
  assert.deepEqual(initialWorkspaceSelection(catalog,{sessionId:'s0',resourceId:null,view:'plans'},'older'),
    {projectId:'current',route:{sessionId:'s0',resourceId:null,view:'plans'}});
  assert.deepEqual(initialWorkspaceSelection(catalog,{sessionId:'s0',resourceId:'host',view:'plans'},'current'),
    {projectId:'older',route:{sessionId:'s7',resourceId:'host'}});
});

test("deleted preferences and stale links fall back safely while empty selected projects stay selected", () => {
  const catalog = {projects:[{id:'current'},{id:'older'},{id:'empty'}],sessions,resources:[]} as unknown as Catalog;
  assert.deepEqual(initialWorkspaceSelection(catalog,{sessionId:'deleted',resourceId:'deleted',view:'plans'},'gone'),
    {projectId:'current',route:{sessionId:'s0',resourceId:null}});
  assert.deepEqual(initialWorkspaceSelection(catalog,{sessionId:null,resourceId:null},'empty'),
    {projectId:'empty',route:{sessionId:null,resourceId:null}});
  assert.deepEqual(initialWorkspaceSelection({projects:[],sessions:[],resources:[]},{sessionId:null,resourceId:null},'gone'),
    {projectId:null,route:{sessionId:null,resourceId:null}});
});
