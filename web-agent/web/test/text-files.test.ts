import assert from "node:assert/strict";
import test from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {decodeTextFile, textFileLimit} from "../src/textFiles";
import {ImportResourceRows} from "../src/ResourceImport";

test("text files decode UTF-8, UTF-16 and GB18030 independently of extension", () => {
  assert.equal(decodeTextFile(new TextEncoder().encode("名称,地址\n服务,10.2.3.4")),"名称,地址\n服务,10.2.3.4");
  assert.equal(decodeTextFile(new Uint8Array([0xff,0xfe,0x41,0,0x0a,0])),"A\n");
  assert.equal(decodeTextFile(new Uint8Array([0xfe,0xff,0,0x41,0,0x0a])),"A\n");
  assert.equal(decodeTextFile(new Uint8Array([0xd6,0xd0,0xce,0xc4])),"中文");
});
test("binary and oversized inputs fail before upload", () => {
  assert.throws(() => decodeTextFile(new Uint8Array([0x41,0,0x42])),/文本文件/);
  assert.throws(() => decodeTextFile(new Uint8Array(textFileLimit+1)),/1 MB/);
  assert.throws(() => decodeTextFile(new Uint8Array([])),/文本文件/);
});
test("resource preview enables valid rows and clearly excludes invalid connections", () => {
  const html=renderToStaticMarkup(createElement(ImportResourceRows,{rows:[{index:0,name:"App",kind:"ssh",folder:"Production",error:"",host:"10.2.3.4",port:22,hasCredential:true},{index:1,name:"Bad",kind:"ssh",folder:"",error:"Invalid port",hasCredential:false}],selected:[0],onSelect(){}}));
  assert.ok(html.includes('checked=""'));
  assert.ok(html.includes('disabled=""'));
  assert.ok(html.includes("Invalid port"));
  assert.ok(html.includes("凭据已安全读取"));
});
