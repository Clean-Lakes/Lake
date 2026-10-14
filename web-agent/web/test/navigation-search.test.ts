import test from "node:test";
import assert from "node:assert/strict";
import { resourceSearchNodes } from "../src/navigationSearch.ts";
import type { Resource, ResourceTreeNode } from "../../shared/contracts.ts";

const resource: Resource = {id:"r",projectId:"p",name:"db-node",kind:"ssh",description:"",status:"available"};
const node = (id:string,parentId:string|null,kind:"folder"|"resource"="folder",resourceId:string|null=null,projectId="p"):ResourceTreeNode => ({id,projectId,parentId,kind,resourceId,name:id,position:0});

test("search keeps the original folder ancestry and removes unrelated branches", () => {
  const nodes = [node("root",null),node("child","root"),node("match","child","resource","r"),node("empty",null),node("other","empty","resource","other")];
  assert.deepEqual(resourceSearchNodes("p",nodes,[resource]).map(item=>item.id),["root","child","match"]);
  assert.deepEqual(resourceSearchNodes("p",nodes,[]),[]);
});

test("search excludes foreign project nodes and terminates for malformed cycles", () => {
  const nodes = [node("a","b"),node("b","a"),node("match","a","resource","r"),node("foreign",null,"resource","r","other")];
  assert.deepEqual(resourceSearchNodes("p",nodes,[resource]).map(item=>item.id),["a","b","match"]);
  assert.deepEqual(resourceSearchNodes("other",nodes,[resource]),[]);
});
