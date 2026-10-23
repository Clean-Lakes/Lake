import test from "node:test";
import assert from "node:assert/strict";
import type {ResourceTreeNode} from "../../shared/contracts";
import {canMoveInto, dropPlacement, projectResourceTree, treeChildren, treeDropZone} from "../src/resource-tree-model";

const nodes: ResourceTreeNode[] = [
  {id:"folder",projectId:"p",parentId:null,kind:"folder",name:"Production",resourceId:null,position:1},
  {id:"child",projectId:"p",parentId:"folder",kind:"folder",name:"Database",resourceId:null,position:0},
  {id:"host",projectId:"p",parentId:null,kind:"resource",name:"",resourceId:"host",position:0},
];
test("folders precede standalone resources while preserving order within each group",()=>{
  assert.deepEqual(treeChildren(nodes,null).map(node=>node.id),["folder","host"]);
  assert.deepEqual(treeChildren(nodes,"folder").map(node=>node.id),["child"]);
});
test("dragging into descendants, self, a resource or an unknown parent is rejected",()=>{
  for(const parent of ["folder","child","host","missing"])assert.equal(canMoveInto(nodes,"folder",parent),false);
  assert.ok(canMoveInto(nodes,"host","child"));assert.ok(canMoveInto(nodes,"host",null));
});
test("drop before/after sorts siblings, while the middle of a folder changes the parent",()=>{
  assert.deepEqual(dropPlacement(nodes,nodes[0]!,"inside"),{parentId:"folder",beforeId:null});
  assert.deepEqual(dropPlacement(nodes,nodes[2]!,"before"),{parentId:null,beforeId:"host"});
  assert.deepEqual(dropPlacement(nodes,nodes[2]!,"after"),{parentId:null,beforeId:null});
});
test("new/legacy resources appear at root without discarding saved placements",()=>{
  const resources=[{id:"new",projectId:"p",name:"New",kind:"ssh" as const,description:"",status:"available" as const}];
  const tree=projectResourceTree("p",nodes,resources);
  assert.deepEqual(tree.slice(0,3),nodes);assert.equal(tree.at(-1)?.resourceId,"new");assert.equal(tree.at(-1)?.position,2);
});

test("built-in local entries recover to root and cannot be moved or covered by drop targets",()=>{
 const resources=[{id:"local",projectId:"p",name:"My local",kind:"local" as const,description:"",status:"available" as const}];
 const tree=projectResourceTree("p",[...nodes,{id:"local-node",projectId:"p",parentId:"child",kind:"resource",name:"",resourceId:"local",position:8}],resources);
 const local=tree.find(node=>node.resourceId==="local")!;
 assert.equal(local.parentId,null);assert.equal(treeChildren(tree,null)[0]?.id,local.id);
 assert.equal(canMoveInto(tree,local.id,"folder"),false);assert.equal(canMoveInto(tree,local.id,null),false);
 assert.deepEqual(dropPlacement(tree,local,"before"),{parentId:null,beforeId:"folder"});
});

test("cross-group drops land at the folder/resource boundary and never jump above folders",()=>{
 const more:ResourceTreeNode[]=[...nodes,{...nodes[0]!,id:'second-folder',position:99},{...nodes[2]!,id:'second-host',resourceId:'second-host',position:2}];
 assert.deepEqual(dropPlacement(more,nodes[0]!,"before",'second-host'),{parentId:null,beforeId:'host'});
 assert.deepEqual(dropPlacement(more,nodes[2]!,"after",'second-folder'),{parentId:null,beforeId:'host'});
 assert.deepEqual(dropPlacement(more,nodes[0]!,"inside",'second-folder'),{parentId:'folder',beforeId:null});
 assert.deepEqual(treeChildren(more,null).map(n=>n.id),['folder','second-folder','host','second-host']);
});
test("vertical folder dragging sorts; moving right into the middle explicitly nests",()=>{
 assert.equal(treeDropZone(nodes[0]!,.45,8),'before');assert.equal(treeDropZone(nodes[0]!,.65,8),'after');
 assert.equal(treeDropZone(nodes[0]!,.5,70),'inside');assert.equal(treeDropZone(nodes[0]!,.1,70),'before');
 assert.equal(treeDropZone(nodes[2]!,.5,70),'after');
});
