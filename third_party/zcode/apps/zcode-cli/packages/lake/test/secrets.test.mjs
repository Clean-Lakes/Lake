import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,writeFile,readFile,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { legacyPipe,migrateSecrets,runLakeSecretMigration } from "../dist/adapters/cli/secrets.js";
import { saveModelConfig } from "../dist/adapters/config/files.js";
import { FileVault } from "../dist/adapters/vault.js";

test("normal runtime refuses legacy access; explicit migration uses private FD 3 and preserves data first",async()=>{
 const root=await mkdtemp(join(tmpdir(),"lake-migration-")),launcher=join(root,"fixture-launcher");
 const old=[process.env.LAKE_EXPLICIT_SECRET_MIGRATION,process.env.LAKE_SIGNED_LAUNCHER];
 try{
 delete process.env.LAKE_EXPLICIT_SECRET_MIGRATION;delete process.env.LAKE_SIGNED_LAUNCHER;
 await assert.rejects(migrateSecrets(root,{}),/签名/);
 await writeFile(launcher,`#!${process.execPath}\nconst fs=require('node:fs');const action=process.argv[3];fs.appendFileSync(${JSON.stringify(join(root,"actions"))},action+'\\n');if(action.startsWith('load-'))fs.writeSync(3,'synthetic-migration-value');`,{mode:0o700});
 assert.equal((await legacyPipe(launcher,"load-model","fixture")).toString(),"synthetic-migration-value");
 await saveModelConfig(root,{model_providers:{fixture:{base_url:"https://example.invalid",wire_api:"anthropic"}}});
 process.env.LAKE_EXPLICIT_SECRET_MIGRATION="1";process.env.LAKE_SIGNED_LAUNCHER=launcher;
 const result=await migrateSecrets(root,{dispatch:async()=>[]});assert.deepEqual(result,{migrated:["model:fixture"],failed:[]});
 const oldRoot=process.env.LAKE_HOME;process.env.LAKE_HOME=root;let output="",error="";
 try{assert.equal(await runLakeSecretMigration({argv:["secrets","migrate"],stdin:[],stdout:{write:value=>output+=value},stderr:{write:value=>error+=value}}),0);assert.deepEqual(JSON.parse(output),{migrated:[],failed:[]});assert.equal(error,"");}
 finally{if(oldRoot===undefined)delete process.env.LAKE_HOME;else process.env.LAKE_HOME=oldRoot;}
 const bytes=await new FileVault(root).load("model","fixture");try{assert.equal(bytes.toString(),"synthetic-migration-value");}finally{bytes.fill(0);}
 assert.equal((await readFile(join(root,"actions"),"utf8")).trim().split("\n").at(-1),"delete-model");
 }finally{for(const [i,name] of ["LAKE_EXPLICIT_SECRET_MIGRATION","LAKE_SIGNED_LAUNCHER"].entries())if(old[i]===undefined)delete process.env[name];else process.env[name]=old[i];await rm(root,{recursive:true,force:true});}
});
