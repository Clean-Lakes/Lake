import test from 'node:test';
import assert from 'node:assert/strict';
import {ExternalPublicText} from './acp/public-text';

test('ACP prose follows actual message identities while the run audit stays cumulative',()=>{
 const prose=new ExternalPublicText('run-a',text=>text);
 const first=prose.append('正在读取。','progress');
 const append=prose.append('继续核对。','progress');
 assert.equal(append.publicTextId,first.publicTextId);
 assert.equal(append.publicText,'正在读取。继续核对。');
 // Tool notifications do not enter this accumulator or fabricate a text boundary.
 const afterTool=prose.append('读取结束。','progress');
 assert.equal(afterTool.publicTextId,first.publicTextId);
 assert.equal(afterTool.publicText,'正在读取。继续核对。读取结束。');
 const final=prose.append('本轮结论。','final');
 assert.notEqual(final.publicTextId,first.publicTextId);
 assert.equal(final.publicText,'本轮结论。');
 assert.equal(final.text,'正在读取。继续核对。读取结束。本轮结论。');
 assert.equal(prose.auditText,final.text);
 const more=prose.append('补充。','final');
 assert.equal(more.publicTextId,final.publicTextId);
 assert.equal(more.publicText,'本轮结论。补充。');
 assert.notEqual(new ExternalPublicText('run-b',text=>text).append('本轮结论。','final').publicTextId,final.publicTextId,'other runs cannot borrow a visible message identity');
});

test('legacy adapters retain cumulative prose with an identity distinct from real messages',()=>{
 const prose=new ExternalPublicText('legacy-run',text=>text);
 const first=prose.append('准备。',undefined),next=prose.append('结果。',undefined);
 assert.equal(first.publicTextId,next.publicTextId);
 assert.equal(next.publicText,'准备。结果。');
 const known=prose.append('有身份。','legacy');
 assert.notEqual(known.publicTextId,next.publicTextId);
 const fallback=prose.append('兼容。',undefined);
 assert.equal(fallback.publicTextId,next.publicTextId);
 assert.equal(fallback.publicText,'准备。结果。有身份。兼容。');
 for(const invalid of ['',1,{},'x'.repeat(513)])assert.equal(prose.append('',invalid).publicTextId,first.publicTextId);
});

test('new empty messages do not inherit old prose and interleaved IDs retain only their own prefixes',()=>{
 const prose=new ExternalPublicText('run',text=>text);
 const first=prose.append('过程。','first'),empty=prose.append('','final');
 assert.notEqual(first.publicTextId,empty.publicTextId);
 assert.equal(empty.publicText,'');
 assert.equal(empty.text,'过程。');
 assert.equal(prose.append('增量。','first').publicText,'过程。增量。');
 assert.equal(prose.append('结论。','final').publicText,'结论。');
});

test('both public messages and cumulative audit use live redaction before persistence',()=>{
 const secret='synthetic-private-value',seen:boolean[]=[];
 const redact=(value:string,live?:boolean)=>{
  seen.push(live===true);
  let prefix=0;
  for(let n=1;n<secret.length;n++)if(value.endsWith(secret.slice(0,n)))prefix=n;
  return (prefix?value.slice(0,-prefix)+'[REDACTED]':value).split(secret).join('[REDACTED]');
 };
 const prose=new ExternalPublicText('run',redact);
 const partial=prose.append('准备 synthetic-pri','first');
 assert.equal(partial.publicText,'准备 [REDACTED]');
 const complete=prose.append('vate-value。','first');
 assert.equal(complete.publicText,'准备 [REDACTED]。');
 const final=prose.append(secret+' 已屏蔽。',secret);
 assert.equal(final.publicText,'[REDACTED] 已屏蔽。');
 assert.ok(!JSON.stringify([partial,complete,final]).includes(secret));
 assert.ok(seen.every(Boolean));
});

test('public messages share the existing run text limit',()=>{
 const prose=new ExternalPublicText('run',text=>text),large=prose.append('a'.repeat(1024*1024+5),'first');
 assert.equal(prose.auditText.length,1024*1024);
 assert.equal(large.text.length,32768);assert.equal(large.publicText.length,32768);
 const final=prose.append('not retained beyond the existing budget','final');
 assert.equal(final.publicText,'');assert.equal(prose.auditText.length,1024*1024);
});
