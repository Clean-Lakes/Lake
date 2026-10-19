import assert from "node:assert/strict";
import test from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {messageTextParts,rebaseMessageMentions} from "../src/messageMentions";
import {MessageText} from "../src/MessageText";
import {composerMessage,appendResourceMention,composerToken} from "../src/composerMentionState";
import type {MessageMention} from "../../shared/contracts";

test("sent mixed references preserve UTF-16 positions, plain text and original labels after rename",()=>{
 const a=appendResourceMention('  🔎检查和的状态  ',[],{id:'a',name:'主机A'},6);
 const b=appendResourceMention(a.next,a.references,{id:'b',name:'主机B'},8);
 const wire=composerMessage(b.next,b.references,['a','b']);
 const parts=messageTextParts(wire.text,wire.mentions,[{id:'a',name:'已重命名',kind:'ssh'}]);
 assert.deepEqual(parts.map(part=>part.mention?.id).filter(Boolean),['a','b']);
 assert.equal(parts.map(part=>part.mention?part.mention.label:part.text).join(''),wire.text);
 assert.equal(parts.filter(p=>p.mention).map(p=>p.text).join(','),'主机A,主机B');
 for(const ref of wire.mentions)assert.equal(wire.text.slice(ref.start,ref.end),ref.label);
 assert.ok(!wire.text.includes(composerToken));
});
test("adjacent legacy resource names restore separate labels while unknown names stay literal",()=>{
 const resources=[{id:'a',name:'服务',kind:'ssh' as const},{id:'b',name:'服务生产',kind:'database' as const}];
 const parts=messageTextParts('@服务生产和@服务@未知',undefined,resources);
 assert.deepEqual(parts.map(p=>p.mention?.id).filter(Boolean),['b','a']);
 assert.equal(parts.map(p=>p.text).join(''),'服务生产和服务@未知');
 assert.deepEqual(messageTextParts('@服务',[],resources),[{text:'@服务'}]);
});
test("invalid and overlapping spans cannot hide or replace unrelated user prose",()=>{
 const base:MessageMention={kind:'resource',id:'a',label:'@A',start:1,end:3};
 assert.deepEqual(messageTextParts('前@A后',[{...base,label:'@B'},{...base,start:-1}]),[{text:'前@A后'}]);
 const parts=messageTextParts('前@A后',[base,base]);
 assert.equal(parts.map(p=>p.text).join(''),'前A后');assert.equal(parts.filter(p=>p.mention).length,1);
});
test("queue editing moves selected label ranges and drops references edited through",()=>{
 const ref:MessageMention={kind:'resource',id:'a',label:'@A',start:0,end:2};
 assert.deepEqual(rebaseMessageMentions('@A 后续','先@A 后续',[ref]),[{...ref,start:1,end:3}]);
 assert.deepEqual(rebaseMessageMentions('@A 后续','@B 后续',[ref]),[]);
});
test("sent labels use icons, escaped names and no @ or remove control",()=>{
 const text='请检查@<server>再汇报';
 const html=renderToStaticMarkup(createElement(MessageText,{text,mentions:[{kind:'resource',id:'a',label:'@<server>',start:3,end:12,resourceKind:'ssh'}]}));
 assert.ok(html.includes('data-message-reference="resource:a"'));
 assert.ok(html.includes('&lt;server&gt;'));
 assert.ok(!html.includes('@')&&!html.includes('<button')&&!html.includes('<server>'));
});
