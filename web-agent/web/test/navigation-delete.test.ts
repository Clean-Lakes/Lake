import assert from "node:assert/strict";
import test from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {Project,Resource,ResourceTreeNode} from "../../shared/contracts";
import {ResourceTree} from "../src/ResourceTree";

test("resource and folder rows put deletion in their more menus",()=>{
 const project={id:"p",name:"Project"} as Project;
 const resources=[{id:"local",projectId:"p",name:"Local machine",kind:"local"},{id:"db",projectId:"p",name:"Database",kind:"database"}] as Resource[];
 const nodes:ResourceTreeNode[]=[{id:"local",projectId:"p",parentId:null,kind:"resource",name:"",resourceId:"local",position:0}];
 let parent:string|null=null;
 for(let depth=0;depth<10;depth++){const id=`folder-${depth}`;nodes.push({id,projectId:"p",parentId:parent,kind:"folder",name:`Level ${depth}`,resourceId:null,position:1});parent=id;}
 nodes.push({id:"db",projectId:"p",parentId:parent,kind:"resource",name:"",resourceId:"db",position:0});
 const html=renderToStaticMarkup(createElement(ResourceTree,{project,resources,nodes,disabled:false,filtering:true,selection:{has:()=>false,toggle(){},disabled:false},renderResource:resource=>createElement("span",null,resource.name),refresh:async()=>{},onAddResource(){},onImport(){},onDelete(){}}));
 assert.ok(!html.includes('aria-label="删除资源 '));assert.ok(html.includes('aria-label="管理资源 Database"'));
 assert.equal((html.match(/aria-label="管理文件夹 /g)||[]).length,10);
 assert.ok(html.includes('margin-left:0'),"deep nesting caps indentation to retain row controls");
 assert.ok(!html.includes("navigation-delete-button"));
 assert.ok(!html.includes('拖动或移动 Local machine')&&!html.includes('选择资源 Local machine'),"built-in local has neither a drag handle nor a bulk deletion checkbox");
 assert.equal((html.match(/class="navigation-more-button resource-more-button"/g)||[]).length,1);
});

function folderMarkup(saved: Record<string,string> = {}, filtering = false) {
 const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
 Object.defineProperty(globalThis, "localStorage", {configurable:true,value:{getItem:(key:string)=>saved[key] ?? null}});
 try {
  const project={id:"p",name:"Project"} as Project;
  const resources=[{id:"host",projectId:"p",name:"Nested host",kind:"ssh"}] as Resource[];
  const nodes:ResourceTreeNode[]=[
   {id:"folder",projectId:"p",parentId:null,kind:"folder",name:"Production",resourceId:null,position:0},
   {id:"child",projectId:"p",parentId:"folder",kind:"folder",name:"Database",resourceId:null,position:0},
   {id:"host",projectId:"p",parentId:"child",kind:"resource",name:"",resourceId:"host",position:0},
   {id:"new",projectId:"p",parentId:null,kind:"folder",name:"New folder",resourceId:null,position:1},
  ];
  return renderToStaticMarkup(createElement(ResourceTree,{project,resources,nodes,filtering,disabled:false,renderResource:resource=>createElement("span",null,resource.name),refresh:async()=>{},onAddResource(){},onImport(){},onDelete(){}}));
 } finally {
  if(previous)Object.defineProperty(globalThis,"localStorage",previous);
  else Reflect.deleteProperty(globalThis,"localStorage");
 }
}
test("resource folders default to collapsed, including legacy preferences and invalid storage",()=>{
 for(const saved of [{},{"lake.resource-folders.p":"[]"},{"lake.resource-folders.expanded.p":"invalid"},{"lake.resource-folders.expanded.p":"{}"}]) {
  const html=folderMarkup(saved);
  assert.equal((html.match(/class="resource-folder-toggle"[^>]*aria-expanded="false"/g)||[]).length,2);
  assert.ok(!html.includes('管理文件夹 Production / Database'));
  assert.ok(!html.includes('Nested host'));
 }
});
test("only explicitly expanded folders reopen; new and nested folders remain collapsed",()=>{
 const html=folderMarkup({"lake.resource-folders.expanded.p":'["folder",17,null]'});
 assert.ok(html.includes('管理文件夹 Production / Database'));
 assert.ok(!html.includes('Nested host'));
 assert.equal((html.match(/class="resource-folder-toggle"[^>]*aria-expanded="true"/g)||[]).length,1);
 assert.equal((html.match(/class="resource-folder-toggle"[^>]*aria-expanded="false"/g)||[]).length,2);
 assert.ok(!folderMarkup({"lake.resource-folders.expanded.other":'["folder","child"]'}).includes('Nested host'));
});
test("resource search reveals nested matches without changing saved expansion preferences",()=>{
 const saved={"lake.resource-folders.expanded.p":"[]"};
 assert.ok(folderMarkup(saved,true).includes('Nested host'));
 assert.ok(!folderMarkup(saved).includes('Nested host'));
});
