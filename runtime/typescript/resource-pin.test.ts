import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {LakeStore} from "./store";
import {digest} from "./tasks";
import {issueResourcePin,boundResourceRevision} from "./resource-pin";

test("short catalog pins resolve only to the original full connection revision for this exact project and host", async t=>{
 const dir=await mkdtemp(join(tmpdir(),"lake-pin-")),store=await LakeStore.open(dir,join(dir,"data"));
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 const a={projectId:"project",id:"JD"},b={projectId:"project",id:"UK"},revision=digest(["original"]);
 const pin=issueResourcePin(store,a,revision)!;
 assert.match(pin,/^pin_[a-f0-9]{12}$/);
 assert.equal(issueResourcePin(store,a,revision),pin);
 assert.equal(boundResourceRevision(store,a,pin,revision),true);
 assert.equal(boundResourceRevision(store,b,pin,revision),false);
 assert.equal(boundResourceRevision(store,{...a,projectId:"sibling"},pin,revision),false);
 assert.equal(boundResourceRevision(store,a,pin,digest(["rotated"])),false);
 assert.equal(boundResourceRevision(store,a,pin.slice(0,-1),revision),false);
 assert.equal(boundResourceRevision(store,a,revision+revision.slice(0,8),revision),false);
});
