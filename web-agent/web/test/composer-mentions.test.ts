import assert from "node:assert/strict";
import test from "node:test";
import type {MCPServerConfig,Resource,SkillConfig} from "../../shared/contracts";
import {rebaseMentions,referencedExtensions,referencedResources,rebaseExtensionReferences} from "../../shared/references";
import {composerMessage,composerResourceIds,selectComposerMention,appendResourceMention,filterMentions,mentionInsertion,mentionOptions,type MentionOption} from "../src/composerMentionState";

const skill:SkillConfig={name:"service-check",description:"检查服务健康",path:"/fixture/SKILL.md",source:"Lake",enabled:true,managed:true};
const mcp:MCPServerConfig={id:"tools",name:"Team tools",transport:"http",enabled:true,url:"http://localhost:1",command:"",args:[],headersConfigured:false,envConfigured:false};
test("mentions expose enabled Skills and MCP services without mixing same-name identities",()=>{
 const resources=[{id:"tools",name:"Team tools",status:"available"}] as Resource[];
 const options=mentionOptions(resources,[skill,{...skill,name:"disabled",enabled:false}],[mcp,{...mcp,id:"off",enabled:false}]);
 assert.deepEqual(options.map(o=>[o.kind,o.id]),[["resource","tools"],["skill","service-check"],["mcp","tools"]]);
 assert.equal(filterMentions(options,"健康","skill")[0]?.id,"service-check");
 assert.equal(filterMentions(options,"TEAM","mcp")[0]?.id,"tools");
});
test("a long resource list does not truncate extension choices",()=>{
 const options=mentionOptions(Array.from({length:150},(_,i)=>({id:String(i),name:`Host ${i}`,status:"available"} as Resource)),[skill],[mcp]);
 assert.equal(filterMentions(options,"","all").length,152);
 assert.equal(filterMentions(options,"","mcp").length,1);
});
test("insertion at a newline preserves whitespace, following text and exact mention offsets",()=>{
 const option:MentionOption={id:skill.name,name:skill.name,kind:"skill",detail:""};
 const original="检查\n@ser 后续文字",caret=original.indexOf(" 后续");
 const result=mentionInsertion(original,caret,option);
 assert.equal(result.next,"检查\n@service-check  后续文字");
 assert.equal(result.next.slice(result.reference.start,result.reference.end),"@service-check");
 assert.equal(result.next[result.position]," ");
});
test("selected extension references survive UTF-16 edits, and disappear when their mention is edited",()=>{
 const insert=mentionInsertion("  🔎 @",6,{id:skill.name,name:skill.name,kind:"skill",detail:""});
 const refs=[insert.reference];
 const wire=referencedExtensions(insert.next,refs);
 assert.equal(wire[0]?.start,3);
 assert.equal(insert.next.trim().slice(wire[0]!.start as number,wire[0]!.end as number),"@service-check");
 assert.deepEqual(referencedResources(insert.next,refs,[skill.name]),[]);
 const changed=insert.next.replace("service-check","service-chec");
 assert.deepEqual(referencedExtensions(changed,rebaseMentions(insert.next,changed,refs)),[]);
 assert.deepEqual(referencedExtensions("@service-check",[]),[]);
});
test("same-name resource and MCP selections stay separate and extension sends deduplicate",()=>{
 const first=mentionInsertion("@",1,{id:"tools",name:mcp.name,kind:"resource",detail:""});
 const next=first.next+"@";
 const second=mentionInsertion(next,next.length,{id:"tools",name:mcp.name,kind:"mcp",detail:""});
 const refs=[first.reference,second.reference,second.reference];
 assert.deepEqual(referencedResources(second.next,refs,["tools"]),["tools"]);
 assert.equal(referencedExtensions(second.next,refs).length,1);
});
test("queue editing rebases chosen extensions and removes only deleted mentions",()=>{
 const text="@service-check @Team tools 检查";
 const refs=[{kind:"skill",skill_name:skill.name,label:"@service-check",start:0,end:14},{kind:"mcp",server_id:mcp.id,label:"@Team tools",start:15,end:26}];
 const next="@service-check 检查";
 assert.deepEqual(rebaseExtensionReferences(text,next,refs),[refs[0]]);
 assert.equal(rebaseExtensionReferences(text,"先 "+text,refs)[1]?.start,17);
});

test("sidebar tokens preserve editable prose and deduplicate by resource ID",()=>{
 const resource={id:"host",name:"应用服务器 一"};
 for(const draft of ["","检查一下","检查\n","检查 @未完成"]) {
  const first=appendResourceMention(draft,[],resource),again=appendResourceMention(first.next,first.references,resource);
  assert.equal(first.next,draft);
  assert.equal(first.position,draft.length);
  assert.equal(again.references.length,1);
  assert.deepEqual(composerResourceIds(first.references,["host"]),["host"]);
  assert.equal(composerMessage("检查状态",first.references,["host"]).text,"检查状态");
 }
});
test("@ selection consumes only the query; tokens survive prose edits and keep same-name identities separate",()=>{
 const first=selectComposerMention("检查\n@ser 后续",7,[],{id:"host",name:"同名",kind:"skill",detail:""});
 assert.equal(first.next,"检查\n 后续");
 const resource=appendResourceMention(first.next,first.references,{id:"host",name:"同名"});
 const other=appendResourceMention(resource.next,resource.references,{id:"other",name:"同名"});
 assert.equal(other.references.length,3);
 assert.deepEqual(composerResourceIds(other.references,["host","other"]),["host","other"]);
 const payload=composerMessage("🔎 改写后的正文",other.references,["host"]);
 assert.equal(payload.text,"@同名 🔎 改写后的正文");
 assert.deepEqual(payload.resourceIds,["host"]);
 assert.equal(payload.references[0]?.kind,"skill");
 assert.equal(payload.references[0]?.start,0);
 assert.equal(payload.references[0]?.end,3);
 assert.equal(selectComposerMention("@",1,other.references,{id:"host",name:"同名",kind:"skill",detail:""}).references.length,3);
});
test("extension tokens serialize with verified UTF-16 spans and queue edits retain their identifiers",()=>{
 let refs=selectComposerMention("@",1,[],{id:"service-check",name:"service-check",kind:"skill",detail:""}).references;
 refs=selectComposerMention("@",1,refs,{id:"tools",name:"工具 🔎",kind:"mcp",detail:""}).references;
 const payload=composerMessage("  检查一下  ",refs,[]);
 assert.equal(payload.text,"@service-check @工具 🔎 检查一下");
 assert.equal(payload.references.length,2);
 for(const ref of payload.references)assert.equal(payload.text.slice(ref.start as number,ref.end as number),ref.label);
 assert.deepEqual(rebaseExtensionReferences(payload.text,payload.text.replace("检查一下","再查一次"),payload.references),payload.references);
 const onlyResource=appendResourceMention("",[],{id:"host",name:"本机"});
 assert.equal(composerMessage("",onlyResource.references,["host"]).text,"@本机");
 assert.equal(composerMessage("",[],[]).text,"");
});
