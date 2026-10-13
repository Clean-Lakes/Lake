import assert from "node:assert/strict";
import test from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {Project,Resource,ResourceTreeNode} from "../../shared/contracts";
import {ResourceTree} from "../src/ResourceTree";

test("every resource and nested folder exposes a visible named delete control",()=>{
 const project={id:"p",name:"Project"} as Project;
 const resources=[{id:"local",projectId:"p",name:"Local machine",kind:"local"},{id:"db",projectId:"p",name:"Database",kind:"database"}] as Resource[];
 const nodes:ResourceTreeNode[]=[{id:"local",projectId:"p",parentId:null,kind:"resource",name:"",resourceId:"local",position:0}];
 let parent:string|null=null;
 for(let depth=0;depth<10;depth++){const id=`folder-${depth}`;nodes.push({id,projectId:"p",parentId:parent,kind:"folder",name:`Level ${depth}`,resourceId:null,position:1});parent=id;}
 nodes.push({id:"db",projectId:"p",parentId:parent,kind:"resource",name:"",resourceId:"db",position:0});
 const html=renderToStaticMarkup(createElement(ResourceTree,{project,resources,nodes,disabled:false,renderResource:resource=>createElement("span",null,resource.name),refresh:async()=>{},onAddResource(){},onImport(){},onDelete(){}}));
 assert.ok(html.includes('aria-label="删除资源 Local machine"'));assert.ok(html.includes('aria-label="删除资源 Database"'));
 assert.equal((html.match(/aria-label="删除文件夹 /g)||[]).length,10);
 assert.ok(html.includes('margin-left:0'),"deep nesting caps indentation to retain row controls");
 assert.equal((html.match(/class="navigation-delete-button resource-delete-button"/g)||[]).length,2);
});
