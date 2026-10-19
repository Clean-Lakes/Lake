import assert from "node:assert/strict";
import test from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {Catalog, ResourceTreeNode} from "../../shared/contracts";
import {addBulkTargets, bulkCatalogTargets, bulkKey, orderBulkDeletion, deleteBulkTargets, type BulkTarget} from "../src/bulkNavigation";
import {BulkCheckbox, BulkNavigationDelete} from "../src/BulkNavigationDelete";
const target = (kind: BulkTarget["kind"], id: string, projectId = "p"): BulkTarget => ({kind, id, projectId, name: id});

test("selecting a project excludes permanent session deletion; selecting children deselects the project", () => {
  const session = target("session", "s"), resource = target("resource", "r"), project = target("project", "p"), other = target("session", "other", "q");
  assert.deepEqual(addBulkTargets([session, resource, other], [project]), [other, project]);
  assert.deepEqual(addBulkTargets([project, other], [session, resource, session]).map(bulkKey), ["session:other", "resource:r", "session:s"]);
});
test("deletion closes sessions first and deletes resources and nested folders before parent folders", () => {
  const nodes = [{id:"parent",parentId:null,kind:"folder"}, {id:"child",parentId:"parent",kind:"folder"}] as ResourceTreeNode[];
  const catalog = {projects:[{id:"p",name:"Project"}],resources:[],resourceTree:nodes} as Catalog;
  const selected = [target("folder","parent"), target("folder","child"), target("resource","r"), target("session","s")];
  assert.deepEqual(orderBulkDeletion(selected,catalog).map(bulkKey), ["session:s","resource:r","folder:child","folder:parent"]);
  assert.equal(orderBulkDeletion(selected,catalog)[0]?.projectName, "Project");
  assert.equal(selected[0]?.id,"parent");
});
test("partial failures remain retryable without replaying successful irreversible deletion", async () => {
  const targets = [target("session","s"),target("resource","r"),target("folder","f")];
  const calls: string[] = [];
  const result = await deleteBulkTargets(targets, async item => {calls.push(item.id);if(item.id==="r")throw new Error("close terminal first");}, error => (error as Error).message);
  assert.deepEqual(result.removed.map(item=>item.id),["s","f"]);
  assert.deepEqual(result.failed.map(item=>[item.target.id,item.message]),[["r","close terminal first"]]);
  await deleteBulkTargets(result.failed.map(item=>item.target),async item=>{calls.push(item.id);},String);
  assert.deepEqual(calls,["s","r","f","r"]);
});
test("authentication failure stops the batch and keeps unprocessed items selected", async () => {
  const calls:string[]=[];
  const result=await deleteBulkTargets([target("session","s"),target("resource","r")], async item=>{calls.push(item.id);throw {status:401};},()=>"expired");
  assert.deepEqual(calls,["s"]);
  assert.equal(result.failed.length,2);
  assert.equal(result.removed.length,0);
});
test("catalog selection includes sessions, resources, folders and projects without duplicating resources", () => {
  const catalog={projects:[{id:"p",name:"P"}],sessions:[{id:"s",projectId:"p",title:"S"}],resources:[{id:"r",projectId:"p",name:"R"}],resourceTree:[{id:"r",kind:"resource",projectId:"p"},{id:"f",kind:"folder",projectId:"p",name:"F"}]} as Catalog;
  assert.deepEqual(bulkCatalogTargets(catalog).map(bulkKey),["project:p","session:s","resource:r","folder:f"]);
});
test("confirmation identifies irreversible sessions and leaves untouched folder contents in place", () => {
  const targets=[target("session","s"),target("folder","f")];
  const html=renderToStaticMarkup(createElement(BulkNavigationDelete,{targets,onClose(){},onProcessed:async()=>{},onBusy(){}}));
  assert.ok(html.includes("1 个会话"));
  assert.ok(html.includes("不可恢复"));
  assert.ok(html.includes("其中未选中的资源和子文件夹会移到上一级"));
  const checkbox=renderToStaticMarkup(createElement(BulkCheckbox,{target:targets[0]!,selection:{has:()=>true,toggle(){},disabled:false}}));
  assert.ok(checkbox.includes('aria-label="选择会话 s"'));
  assert.ok(checkbox.includes('checked=""'));
});

test("built-in local resources are excluded from select-all and stale deletion selections",()=>{
 const catalog={projects:[{id:"p",name:"P"}],sessions:[],resources:[{id:"local",projectId:"p",name:"Local",kind:"local"},{id:"remote",projectId:"p",name:"Remote",kind:"ssh"}],resourceTree:[]} as unknown as Catalog;
 assert.deepEqual(bulkCatalogTargets(catalog).map(bulkKey),["project:p","resource:remote"]);
 assert.deepEqual(orderBulkDeletion([target("resource","local"),target("resource","remote")],catalog).map(bulkKey),["resource:remote"]);
});
