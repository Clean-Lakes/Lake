import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationPreview,remarkConversationExcerpt} from '../src/conversationPreview';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import Markdown from 'react-markdown';
import {conversationDirectoryItems} from '../src/ConversationDirectory';
import type {TranscriptEntry} from '../src/timeline';

const card=(id:string,type:string,content:string):TranscriptEntry=>({id,at:'',card:{id,type,content,status:'completed',at:''}});
test('preview uses the recorded final reply and excludes tool output and intermediate commentary',()=>{
 assert.equal(conversationPreview([card('comment','message','准备检查'),card('tool','operation','PRIVATE TOOL OUTPUT'),card('reply','message','原始结论\n\n- 第一项\n- 第二项')]),'原始结论\n\n- 第一项\n- 第二项');
 assert.equal(conversationPreview([card('comment','message','准备检查'),card('tool','operation','PRIVATE TOOL OUTPUT')]),'');
});
test('preview preserves source while rendered excerpts stay bounded inside parsed formatting',()=>{
 const text='👩中文'.repeat(300),shown=conversationPreview([card('reply','message',text)]);
 assert.equal(shown,text);
 const html=renderToStaticMarkup(createElement(Markdown,{remarkPlugins:[remarkConversationExcerpt],children:`**${text}**`}));
 assert.ok(html.startsWith('<p><strong>')&&html.endsWith('</strong></p>'));
 assert.equal(Array.from(html.replace(/<[^>]*>/g,'')).length,640);assert.ok(!html.includes('**'));
});
test('repeated questions retain their own reply association',()=>{
 const messages=[{id:'a',role:'user',text:'重复提问'},{id:'b',role:'user',text:'重复提问'}] as Parameters<typeof conversationDirectoryItems>[0];
 const items=conversationDirectoryItems(messages,new Set(['a','b']),new Map([['a','第一轮回答'],['b','第二轮回答']]));
 assert.equal(items[0]!.summary,'第一轮回答');assert.equal(items[1]!.summary,'第二轮回答');
});
test('specialist previews use the matching report, excluding progress and raw JSON',()=>{
 const entry={id:'sre',at:'',sre:{entry:{kind:'finding',attemptId:'a',body:'{"internal":"report"}'},task:{attempts:[{id:'other',report:{summary:'另一轮回复'}},{id:'a',report:{summary:'本轮已保存的结论'}}]}}} as TranscriptEntry;
 assert.equal(conversationPreview([entry]),'本轮已保存的结论');
 entry.sre!.entry.kind='progress';assert.equal(conversationPreview([entry]),'');
 entry.sre!.entry.kind='finding';entry.sre!.task.attempts=[];assert.equal(conversationPreview([entry]),'');
});
