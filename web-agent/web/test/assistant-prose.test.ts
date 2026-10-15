import assert from "node:assert/strict";
import test from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {remarkAssistantProse} from "../src/assistantProse";

const render = (text:string) => renderToStaticMarkup(createElement(Markdown,{remarkPlugins:[remarkGfm,remarkAssistantProse],skipHtml:true,children:text}));

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
