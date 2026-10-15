import assert from "node:assert/strict";
import test from "node:test";
import type {MCPServerConfig,Resource,SkillConfig} from "../../shared/contracts";
import {rebaseMentions,referencedExtensions,referencedResources,rebaseExtensionReferences} from "../../shared/references";
import {filterMentions,mentionInsertion,mentionOptions,type MentionOption} from "../src/composerMentionState";

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
