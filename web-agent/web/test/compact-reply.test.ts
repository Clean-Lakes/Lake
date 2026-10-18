import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {remarkAssistantProse} from '../src/assistantProse';
import {remarkCompactReply} from '../src/compactReply';
const render=(children:string)=>renderToStaticMarkup(createElement(Markdown,{children,remarkPlugins:[remarkGfm,remarkAssistantProse,remarkCompactReply],skipHtml:true}));
const lead='现有采样未发现新增故障，负载读数变化需要结合实际进程状态判断。'.repeat(2);
export const legacyReply=`## 结论先行\n\n**${lead}**\n\n最后一次检查未完成，后续状态仍待确认。\n\n### 一、基础健康\n\n| 项目 | 观察 |\n| --- | --- |\n| 负载 | 2.70 |\n\n### 二、采样记录\n\n${'这是原始采样依据，不代表新一次检查已经成功。'.repeat(40)}`;
test('long reports reuse their actual introduction and retain the entire original reply behind details',()=>{
 const html=render(legacyReply),before=html.split('<details')[0]!;
 assert.ok(before.includes(lead)&&before.includes('最后一次检查未完成'));
 assert.ok(!before.includes('<h2')&&!before.includes('<strong>')&&!before.includes('<table>'));
 assert.match(html,/<details class="assistant-reply-details">\s*<summary>查看详细结果<\/summary>/);
 assert.ok(html.includes('<h2>结论先行</h2>')&&html.includes('<table>')&&html.includes('这是原始采样依据'));
 assert.ok(legacyReply.includes(`**${lead}**`));
});
test('short conversation, full code and reports without a real introductory conclusion remain intact',()=>{
 for(const text of ['已改好。\n\n验证通过，仍有一项待确认。',`## 基础健康\n\n${'观测原文'.repeat(250)}\n\n### 下一步\n\n检查日志。`,'```md\n'+legacyReply+'\n```']){
  assert.ok(!render(text).includes('assistant-reply-details'));
 }
});
