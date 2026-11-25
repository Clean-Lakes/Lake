import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {CodexAppServer} from './acp/codex-app-server';
import {codexToolDetail,CodexOutputBuffer} from './acp/codex-activity';
import {captureCodexActivity} from './codex-conversation';
import {codexActivity} from '../../web-agent/shared/codex-activity';
import type {AICard} from '../../web-agent/shared/contracts';
import type {ExternalRun,ExternalEvent} from './acp/types';

const at='2026-11-25T01:00:00Z';
const run={id:'run',purpose:'worker',agent:'codex',taskId:'task',rootTurnId:'root'} as ExternalRun;
const operation=():AICard=>({id:'run',type:'operation',at,status:'running',content:'',data:{
 source:'external_agent',external_run_id:'run',external_agent:'codex',root_turn_id:'root',taskId:'task'}});
test('Codex wire appends commentary in place around concrete calls and streams complete output lines',async t=>{
 const card=operation(), seen:string[]=[];
 const adapter=new CodexAppServer({executable:process.execPath,args:[join(__dirname,'test-fixtures/codex-app-server-wire.cjs')],cwd:process.cwd(),env:{LAKE_WIRE_SCENARIO:'inline-activity'}},update=>{
   if(update.kind==='usage'||update.kind==='input')return;
   const event:ExternalEvent=update.kind==='text'?{kind:'text',publicText:update.messageText,publicTextId:update.messageId,sequence:1,at}:{...update,sequence:1,at};
   const item=captureCodexActivity(run,event,card)?.codexItem;
   if(item&&item.kind!=='text'&&item.output)seen.push(item.status+' '+item.output);
 });
 t.after(()=>adapter.close());
 const signal=AbortSignal.timeout(6000);
 await adapter.initialize(signal);await adapter.openSession({cwd:process.cwd()},signal);await adapter.exec('demo',signal);
 const items=codexActivity({cards:[card]},'task','root');
 assert.deepEqual(items.map(item=>[item.kind,item.text]),[['text','检查服务'],['read','inspector.yaml'],['text','核对日志'],['command','journalctl -u inspector -n 20']]);
 assert.deepEqual(seen,['running scan started','completed scan finished']);
 assert.deepEqual(codexActivity({cards:[card]},'other','root'),[]);
 assert.deepEqual(codexActivity({cards:[card]},'task','other'),[]);
});
test('only root workers contribute, file contents and sensitive commands stay outside the transcript',()=>{
 const card=operation(),event:ExternalEvent={kind:'tool',callId:'a',displayKind:'read',detail:'file',status:'running',sequence:1,at};
 for(const other of [{...run,purpose:'child' as const},{...run,childSessionId:'x'},{...run,rootTurnId:undefined}])
   assert.equal(captureCodexActivity(other,event,card),undefined);
 assert.equal(codexToolDetail({type:'mcpToolCall',tool:'Read',arguments:{path:'file'},result:{content:[{text:'private file contents'}]}})?.preview,undefined);
 const hidden=codexToolDetail({type:'commandExecution',command:'cat .env',aggregatedOutput:'secret value'});
 assert.equal(hidden?.detail,'内容已隐藏');assert.equal(hidden?.preview,undefined);
 const lines=new CodexOutputBuffer();
 assert.equal(lines.append('-----BEGIN RSA PRIV'),undefined);
 assert.equal(lines.append('ATE KEY-----\nkey bytes\n'),'敏感输出已隐藏');
 assert.equal(lines.append('-----END RSA PRIVATE KEY-----\nsafe\n'),'safe');
});
