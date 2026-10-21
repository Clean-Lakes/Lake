import assert from "node:assert/strict";
import test from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {remarkAssistantProse} from "../src/assistantProse";
import {SREProse} from '../src/SREReport';

const render = (text:string) => renderToStaticMarkup(createElement(Markdown,{remarkPlugins:[remarkGfm,remarkAssistantProse],skipHtml:true,children:text}));

test('Chinese section references also work without spaces beside the number', () => {
 const html = render('把§1底数同步，按§5.4门禁检查；标识 x§2 和 §3A 保留。');
 assert.ok(html.includes('把第 1 节底数同步，按第 5.4 节门禁检查'));
 assert.ok(html.includes('x§2 和 §3A'));
});

test('section shorthand reads as numbered sections without rewriting code, escapes or links', () => {
 const source = 'PLAN.md：§0 说明，§6 资源，§5.4 门禁。**§1 底数**；**§2 中文 **更新。\n\n`§3`\n\n```text\n§4\n```\n\n[§5](https://example.test/#§5)\n\n\\§7';
 const html = render(source);
 for (const section of ['0', '6', '5.4', '1', '2']) assert.ok(html.includes(`第 ${section} 节`), html);
 assert.ok(html.includes('<code>§3</code>'));
 assert.ok(html.includes('§4\n</code>'));
 assert.ok(html.includes('>§5</a>'));
 assert.ok(html.includes('<p>\\§7</p>'));
 assert.ok(source.includes('§5.4'));
});

test("generated colon labels with a stray closing space render as strong text",()=>{
 const source="设备在线。\n\n- **负载与内存： **4 核，内存充足。\n- **磁盘： **使用 15%。\n- **服务： **SSH 正常。\n\n**结论： **保持观察 `kdump`。";
 const html=render(source);
 assert.ok(html.includes("<strong>负载与内存：</strong> 4 核"));
 assert.ok(html.includes("<strong>磁盘：</strong> 使用 15%"));
 assert.ok(html.includes('class="assistant-summary"'));
 assert.ok(!html.includes("**"));
 assert.ok(source.includes("**磁盘： **"));
});
test("code, escaped Markdown, links and nonlabel literal stars remain unchanged",()=>{
 const html=render("`**磁盘： **`\n\n```sh\necho '**结论： **'\n```\n\n\\*\\*磁盘： \\*\\*\n\n[**磁盘： **](https://example.test/route)\n\nA ** literal ** expression.");
 assert.ok(html.includes("<code>**磁盘： **</code>"));
 assert.ok(html.includes("echo &#x27;**结论： **&#x27;"));
 assert.ok(html.includes("<p>**磁盘： **</p>"));
 assert.ok(html.includes('href="https://example.test/route">**磁盘： **</a>'));
 assert.ok(html.includes("A ** literal ** expression."));
});
test("ordinary strong text, nested lists and table contents keep Markdown semantics",()=>{
 const html=render("**综合结论：** 仍有待核实项。\n\n- **服务**：有异常\n  - 检查记录\n\n| 项目 | 状态 |\n| --- | --- |\n| 磁盘 | **正常** |\n\n<script>alert('x')</script>");
 assert.ok(html.includes('<p class="assistant-summary"><strong>综合结论：</strong>'));
 assert.ok(html.includes("<ul>"));assert.ok(html.includes("<table>"));assert.ok(html.includes("<strong>正常</strong>"));
 assert.ok(!html.includes("<script>"));
});

test('long Chinese conclusions with a space before the closing delimiter render bold',()=>{
 const screenshotBody='服务器本体是健康的，本轮唯一实质变化是“负载读数”从 0.04 涨到 2 上下——但它不是真实压力，是 3 个残留健康检查单元制造出来的读数虚高。';
 for(const body of [screenshotBody,screenshotBody+'本次采集没有执行任何变更。']){
 const source=`## 结论先行\n\n**${body} **没有新增故障、没有容器异常、没有内存或磁盘变化。`;
 const html=render(source);
 assert.ok(html.includes(`<strong>${body}</strong> 没有新增故障`));
 assert.ok(!html.includes('**'));
 assert.equal(source,`## 结论先行\n\n**${body} **没有新增故障、没有容器异常、没有内存或磁盘变化。`);
 }
});
test('Chinese quote and punctuation boundaries and multiple malformed bold spans are recovered',()=>{
 const html=render('这是**“负载读数”**的变化；**服务健康。 **下一步核对。**systemd 启动频率限流（startLimit） **把重试压住了。');
 for(const body of ['“负载读数”','服务健康。','systemd 启动频率限流（startLimit）'])assert.ok(html.includes(`<strong>${body}</strong>`),html);
 assert.ok(!html.includes('**'));
});
test('Chinese literal code, escapes, links and unpaired/triple-star delimiters stay intact',()=>{
 const html=render('`**服务健康。 **`\n\n```text\n**服务健康。 **\n```\n\n\\*\\*服务健康。 \\*\\*\n\n[**服务健康。 **](https://example.test)\n\n**还没有闭合\n\n***服务健康。 ***\n\nA ** literal ** expression.');
 assert.ok(html.includes('<code>**服务健康。 **</code>'));
 assert.ok(html.includes('<p>**服务健康。 **</p>'));
 assert.ok(html.includes('href="https://example.test">**服务健康。 **</a>'));
 assert.ok(html.includes('**还没有闭合'));
 assert.ok(html.includes('***服务健康。 ***'));
 assert.ok(html.includes('A ** literal ** expression.'));
});
test('specialist reports use the same Chinese prose recovery',()=>{
 const html=renderToStaticMarkup(createElement(SREProse,{children:'**服务健康。 **完整记录保留。\n\n| 项目 | 状态 |\n| --- | --- |\n| CPU | **空闲。 ** |'}));
 assert.ok(html.includes('<strong>服务健康。</strong> 完整记录保留。'));
 assert.ok(html.includes('<strong>空闲。</strong>'));
 assert.ok(html.includes('<table>'));
});
