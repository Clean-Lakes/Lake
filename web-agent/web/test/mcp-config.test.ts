import test from 'node:test';
import assert from 'node:assert/strict';
import {formatMCPArgs,mcpJSON,mcpSecretMap,parseMCPArgs,parseMCPJSON,validateMCPInput} from '../src/mcpConfig';

test('MCP named maps and mcpServers wrappers support inferred stdio, HTTP, SSE and batch imports',()=>{
 const input={memory:{command:'npx',args:['-y','@example/memory']},remote:{type:'streamable-http',url:'https://example.test/mcp',headers:{Authorization:'Bearer synthetic-token'},enabled:false},events:{transport:'sse',url:'https://example.test/sse',timeoutMs:15000,protocolVersion:'2025-03-26'}};
 const rows=parseMCPJSON(JSON.stringify({mcpServers:input}));rows.forEach(validateMCPInput);
 assert.deepEqual(rows.map(row=>row.transport),['stdio','http','sse']);
 assert.equal(rows[0]!.timeoutMs,30000);assert.equal(rows[1]!.enabled,false);
 assert.deepEqual(parseMCPJSON(mcpJSON(rows)),rows);
 assert.deepEqual(parseMCPJSON('\uFEFF'+JSON.stringify(input)),rows);
});
test('argument editing preserves quotes, empty arguments, Windows paths, Unicode and JSON control characters',()=>{
 const args=['-y','C:\\Program Files\\工具\\server.js','',`a"b'c`,'space value','中文','[literal]'];
 assert.deepEqual(parseMCPArgs(formatMCPArgs(args)),args);
 const control=['one\ntwo','tab\tvalue','return\rvalue','back\bspace','form\ffeed','control\u0001value'];
 assert.deepEqual(parseMCPArgs(formatMCPArgs(control)),control);
 for(const arg of control)assert.deepEqual(parseMCPArgs(formatMCPArgs([arg])),[arg]);
 assert.deepEqual(parseMCPArgs(`--path 'C:\\Program Files\\x' "two words"`),['--path','C:\\Program Files\\x','two words']);
 assert.throws(()=>parseMCPArgs('"unfinished'),/引号未闭合/);
 assert.throws(()=>parseMCPArgs('[1]'),/字符串数组/);
});
test('invalid import structures are rejected without echoing credential-bearing JSON',()=>{
 for(const value of [[],{}, {mcpServers:{}},{mcpServers:{x:{command:'npx'}},inputs:[]},{x:{type:'stdio',command:'npx',unknown:'synthetic-private'}},{x:{type:'http',transport:'sse',url:'https://example.test'}},{x:{command:'npx',args:[1]}},{x:{command:'npx',env:{TOKEN:42}}},{x:{command:'npx',headers:null}},{x:{command:'npx',timeoutMs:'30000'}}])assert.throws(()=>parseMCPJSON(JSON.stringify(value)));
 try{parseMCPJSON('{"synthetic-private":');assert.fail('must reject invalid JSON');}catch(err){assert.ok(!String(err).includes('synthetic-private'));}
 assert.throws(()=>parseMCPJSON(JSON.stringify({x:{command:'npx'},X:{command:'npx'}})),/重复/);
});
test('saving checks required fields, timeout, protocol and credential-free URLs',()=>{
 const value=parseMCPJSON('{"memory":{"type":"stdio","command":""}}')[0]!;
 assert.throws(()=>validateMCPInput(value),/可执行命令/);
 assert.throws(()=>validateMCPInput({...value,command:'npx',timeoutMs:0}),/超时/);
 assert.throws(()=>validateMCPInput({...value,command:'npx',protocolVersion:'invalid'}),/协议/);
 assert.throws(()=>validateMCPInput({...value,transport:'http',url:'https://user:synthetic-private@example.test/mcp'}),/认证/);
 assert.equal(mcpSecretMap('','环境变量'),undefined);
 assert.deepEqual(mcpSecretMap('{}','环境变量'),{});
 assert.throws(()=>mcpSecretMap('{"TOKEN":"synthetic-private"','环境变量'),err=>!String(err).includes('synthetic-private'));
});
