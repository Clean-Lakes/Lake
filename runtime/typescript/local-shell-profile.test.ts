import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync,mkdirSync,realpathSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {localShellProfile,overlapsPrivateStorage} from "./local-shell-profile";

test("an external data directory stays private under the real sandbox and overlapping workspaces", {skip:process.platform!=="darwin"}, t => {
 const root=realpathSync(mkdtempSync(join(tmpdir(),"lake-private-boundary-")));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const home=join(root,"home"),data=join(root,"external"),workspace=join(home,"workspaces","proj");
 const output=join(data,"tool-output","session");
 for(const dir of [workspace,output]) mkdirSync(dir,{recursive:true});
 const control=join(data,"runtime.json"),file=join(workspace,"readable.txt"),out=join(output,"receipt");
 for(const path of [control,file,out]) writeFileSync(path,"test-only");
 const link=join(workspace,"link"); symlinkSync(control,link);
 for(const projectPath of [root,data,workspace]){
   const profile=localShellProfile(home,data,projectPath,"proj","session");
   const read=(path:string)=>spawnSync("/usr/bin/sandbox-exec",["-p",profile,"/bin/cat",path],{encoding:"utf8"});
   assert.notEqual(read(control).status,0);
   assert.notEqual(read(link).status,0);
   assert.equal(read(out).stdout,"test-only");
   assert.equal(overlapsPrivateStorage(home,data,projectPath,control),true);
   assert.equal(overlapsPrivateStorage(home,data,projectPath,data),true);
 }
 const allowed=localShellProfile(home,data,workspace,"proj","session");
 assert.equal(spawnSync("/usr/bin/sandbox-exec",["-p",allowed,"/bin/cat",file],{encoding:"utf8"}).stdout,"test-only");
 assert.equal(overlapsPrivateStorage(home,data,workspace,file),false);
});
