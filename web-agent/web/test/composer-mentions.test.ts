import assert from "node:assert/strict";
import test from "node:test";
import type {MCPServerConfig,Resource,SkillConfig} from "../../shared/contracts";
import {rebaseMentions,referencedExtensions,referencedResources,rebaseExtensionReferences} from "../../shared/references";
import {composerClipboardFragment,composerToken,replaceComposerRange,composerMessage,composerResourceIds,selectComposerMention,appendResourceMention,filterMentions,mentionInsertion,mentionOptions,nextMentionCategory,mentionTypeLabel,type MentionOption} from "../src/composerMentionState";

test("left and right cycle visible categories including empty categories",()=>{
 assert.equal(nextMentionCategory("all",[],{key:"ArrowRight"}),"resource");
 assert.equal(nextMentionCategory("resource",[],{key:"ArrowRight"}),"skill");
 assert.equal(nextMentionCategory("skill",[],{key:"ArrowRight"}),"mcp");
 assert.equal(nextMentionCategory("mcp",[],{key:"ArrowRight"}),"all");
 assert.equal(nextMentionCategory("all",[],{key:"ArrowLeft"}),"mcp");
 const options=mentionOptions([],[],[],true);
 assert.equal(nextMentionCategory("mcp",options,{key:"ArrowRight"}),"role");
 assert.equal(nextMentionCategory("role",options,{key:"ArrowRight"}),"all");
 assert.equal(nextMentionCategory("all",options,{key:"ArrowLeft"}),"role");
});
test("category navigation preserves modified arrows and other keys",()=>{
 for(const key of ["ArrowLeft","ArrowRight"]){
  for(const modifier of ["shiftKey","metaKey","ctrlKey","altKey"]){
   assert.equal(nextMentionCategory("all",[],{key,[modifier]:true}),null);
  }
 }
 for(const key of ["ArrowUp","ArrowDown","Enter","Tab","Escape"]){
  assert.equal(nextMentionCategory("all",[],{key}),null);
 }
});

const skill:SkillConfig={name:"service-check",description:"检查服务健康",path:"/fixture/SKILL.md",source:"Lake",enabled:true,managed:true};
const mcp:MCPServerConfig={id:"tools",name:"Team tools",transport:"http",enabled:true,url:"http://localhost:1",command:"",args:[],headersConfigured:false,envConfigured:false};
test('same-name resource candidates retain their real types and distinct selection IDs',()=>{
 const kinds:Resource['kind'][]=['ssh','database','redis','docker','local'];
 const options=mentionOptions(kinds.map(kind=>({id:kind,name:'192.0.2.141',kind,status:'available'} as Resource)),[],[]);
 assert.deepEqual(options.map(o=>o.resourceKind),kinds);
 assert.deepEqual(options.map(mentionTypeLabel),['SSH 主机','数据库','Redis','容器','本机']);
 assert.deepEqual(filterMentions(options,'数据库','resource').map(o=>o.id),['database']);
 const picked=selectComposerMention('@141',4,[],options[1]!);
 assert.deepEqual(composerMessage(picked.next,picked.references,kinds).resourceIds,['database']);
});
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

test("resource tokens insert at the caret, preserving prose on both sides and selected identity",()=>{
 const first=appendResourceMention("比较和的负载",[],{id:"a",name:"主机 A"},2);
 assert.equal(first.next,`比较${composerToken}和的负载`);
 const second=appendResourceMention(first.next,first.references,{id:"b",name:"主机 B"},4);
 assert.equal(second.next,`比较${composerToken}和${composerToken}的负载`);
 assert.deepEqual(second.references.map(ref=>ref.position),[2,4]);
 assert.equal(composerMessage(second.next,second.references,["a","b"]).text,"比较@主机 A和@主机 B的负载");
 assert.deepEqual(composerResourceIds(second.references,["a","b"]),["a","b"]);
 const repeated=appendResourceMention(second.next,second.references,{id:"a",name:"主机 A"},0);
 assert.equal(repeated.next,second.next);assert.equal(repeated.references.length,2);assert.equal(repeated.position,3);
});
test("@ selection at any sentence position replaces the query and keeps following text",()=>{
 const first=selectComposerMention("检查@ser 后续",6,[],{id:"host",name:"同名",kind:"skill",detail:""});
 assert.equal(first.next,`检查${composerToken} 后续`);
 assert.equal(first.references[0]?.position,2);
 const resource=appendResourceMention(first.next,first.references,{id:"host",name:"同名"},0);
 assert.equal(resource.references.length,2);
 const payload=composerMessage(resource.next,resource.references,["host"]);
 assert.equal(payload.text,"@同名检查@同名 后续");
 assert.deepEqual(payload.resourceIds,["host"]);
 assert.equal(payload.references[0]?.kind,"skill");assert.equal(payload.references[0]?.start,5);assert.equal(payload.references[0]?.end,8);
});
test("editing before, between and across tokens shifts or removes exactly the selected references",()=>{
 let doc=appendResourceMention("和",[],{id:"a",name:"A"},0);
 doc=appendResourceMention(doc.next,doc.references,{id:"b",name:"B"},2);
 const prefix=replaceComposerRange(doc.next,doc.references,0,0,"🔎比较");
 assert.deepEqual(prefix.references.map(ref=>ref.position),[4,6]);
 const middle=replaceComposerRange(prefix.next,prefix.references,5,6,"与");
 assert.equal(composerMessage(middle.next,middle.references,["a","b"]).text,"🔎比较@A与@B");
 const removed=replaceComposerRange(middle.next,middle.references,4,6,"");
 assert.equal(composerMessage(removed.next,removed.references,["a","b"]).text,"🔎比较@B");
 assert.deepEqual(removed.references.map(ref=>[ref.resourceId,ref.position]),[["b",4]]);
 const all=replaceComposerRange(removed.next,removed.references,0,removed.next.length,"");
 assert.equal(all.next,"");assert.equal(all.references.length,0);
});
test("mixed extension tokens serialize in sentence order with verified UTF-16 spans",()=>{
 let doc=selectComposerMention("🔎先@skill 再检查",9,[],{id:"service-check",name:"service-check",kind:"skill",detail:""});
 // Locate the second query in the document rather than assuming display-label lengths.
 const value=doc.next+"@工具";
 doc=selectComposerMention(value,value.length,doc.references,{id:"tools",name:"工具 🔎",kind:"mcp",detail:""});
 const payload=composerMessage(doc.next,doc.references,[]);
 assert.equal(payload.references.length,2);
 for(const ref of payload.references)assert.equal(payload.text.slice(ref.start as number,ref.end as number),ref.label);
 const edited=payload.text+"。";
 assert.deepEqual(rebaseExtensionReferences(payload.text,edited,payload.references),payload.references);
 assert.equal(composerMessage("",[],[]).text,"");
});

test("internal clipboard tokens retain known IDs while foreign or forged references become plain text",()=>{
 const doc=appendResourceMention("前后",[],{id:"host",name:"主机"},1);
 const raw=JSON.stringify({version:1,value:doc.next,references:[{kind:"resource",resourceId:"host",position:1,label:"forged"}]});
 assert.deepEqual(composerClipboardFragment(raw,doc.references),{value:doc.next,references:doc.references});
 assert.equal(composerClipboardFragment(raw,[]),null);
 assert.equal(composerClipboardFragment(raw.replace('"position":1','"position":0'),doc.references),null);
 assert.equal(composerClipboardFragment('{',doc.references),null);
});
