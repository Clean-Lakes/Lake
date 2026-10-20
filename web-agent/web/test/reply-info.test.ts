import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {remarkReplyInfo,quantityParts,resourceLink} from '../src/replyInfo';
import {replyInfoComponents} from '../src/ReplyInfoElements';
import {SREProse} from '../src/SREReport';
import {AITranscript} from '../src/AIPanel';
import type {SessionSnapshot} from '../../shared/contracts';

const render=(children:string)=>renderToStaticMarkup(createElement(Markdown,{remarkPlugins:[remarkGfm,remarkReplyInfo],components:replyInfoComponents,children}));
const body='## 已恢复仓库并更新组织主页\n\nREADME 已恢复，组织介绍已更新。\n\n提交：`86a30431` 回滚 `062cb970`\n\n分支：`origin/master` · `main`\n\n检查：14个文件 · 1.8秒 · 尚未验证生产\n\n[profile/README.md](https://github.com/Clean-Lakes/.github/blob/main/profile/README.md?view=1)';

test('explicit metadata becomes aligned facts with copyable commits and real file source',()=>{
 const html=render(body);
 assert.ok(html.includes('<dl class="reply-info-facts">'));
 for(const label of ['提交','分支','检查'])assert.ok(html.includes(`<dt>${label}</dt>`));
 assert.ok(html.includes('aria-label="复制提交号 86a30431"'));
 assert.ok(html.includes('尚未验证生产'));
 assert.ok(html.includes('class="reply-number">14</span>'));
 assert.ok(html.includes('class="reply-unit">个文件</span>'));
 assert.ok(html.includes('github.com · Clean-Lakes/.github'));
 assert.ok(html.includes('href="https://github.com/Clean-Lakes/.github/blob/main/profile/README.md?view=1"'));
 assert.ok(!html.includes('<small>github.com · Clean-Lakes/.github?view=1'));
});

test('plain prose, mixed lists, nested steps and code keep their original structure',()=>{
 const html=render('新提交 `86a30431` 已回滚。\n\n- 提交：`86a30431`\n- 仍需检查生产环境\n\n1. 检查：先确认目标\n   - 不自动重试\n\n```text\n检查：14个文件\n<script>x</script>\n```\n\n[文件](https://example.test/file.md) 仍待人工检查。');
 assert.ok(!html.includes('reply-info-facts'));
 assert.ok(!html.includes('复制提交号'));
 assert.ok(html.includes('<ul>')&&html.includes('<ol>'));
 assert.ok(html.includes('检查：14个文件\n&lt;script&gt;x&lt;/script&gt;'));
 assert.ok(!html.includes('reply-resource-link'));
});

test('a list consisting only of explicit facts and strong labels uses the same summary',()=>{
 const html=render('- **提交**：`86a30431`\n- **分支：** `main`\n- 检查：失败，等待确认');
 assert.ok(html.includes('<dl class="reply-info-facts">'));
 assert.ok(!html.includes('<ul>'));
 assert.ok(html.includes('<dt>分支</dt>'));
 assert.ok(html.includes('失败，等待确认'));
});

test('consecutive metadata lines support both soft and explicit Markdown breaks',()=>{
 for(const separator of ['\n','  \n']){
  const html=render(['提交：`86a30431`','分支：`main`','检查：尚未验证'].join(separator));
  assert.equal((html.match(/<dt>/g)??[]).length,3);
  assert.ok(html.includes('<dt>检查</dt><dd>尚未验证</dd>'));
 }
});

test('quantities preserve every character and leave IPs, versions and identifiers whole',()=>{
 const source='14个文件 · 1.8秒 · 31.5 GB · 10.100.33.65 · v1.8.0 · job14s · 2026-10-20s';
 const parts=quantityParts(source);
 assert.equal(parts.map(part=>part.value+(part.unit??'')).join(''),source);
 assert.deepEqual(parts.filter(part=>part.unit).map(part=>part.value),['14','1.8','31.5']);
 assert.equal(resourceLink('javascript:alert(1)'),null);
 assert.equal(resourceLink('https://example.test/project'),null);
 assert.equal(resourceLink('https://user:pass@example.test/report.md?token=private')?.source,'example.test');
});

test('ordinary replies and SRE use the same presentation without changing saved content',()=>{
 const snapshot={session:{id:'summary'},messages:[],actions:[],resources:[],ai:{session:'summary',status:'completed',cardsOffset:0,turns:1,cards:[{id:'reply',type:'message',content:body,status:'completed',at:'2026-10-20T00:00:00Z'}]}} as SessionSnapshot;
 const ordinary=renderToStaticMarkup(createElement(AITranscript,{snapshot}));
 const sre=renderToStaticMarkup(createElement(SREProse,{children:body}));
 for(const html of [ordinary,sre]){
  assert.ok(html.includes('reply-info-facts'));
  assert.ok(html.includes('reply-resource-link'));
  assert.ok(html.includes('aria-label="复制提交号 86a30431"'));
 }
 assert.equal(snapshot.ai!.cards[0]!.content,body);
});
