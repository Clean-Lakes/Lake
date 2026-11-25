import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {CodexAppServer} from './acp/codex-app-server';
import {codexToolDetail,CodexOutputBuffer,publicCommand} from './acp/codex-activity';
import {captureCodexActivity,codexClosingMessageIds,legacyCommandBodies} from './codex-conversation';
import {codexActivity} from '../../web-agent/shared/codex-activity';
import type {AICard} from '../../web-agent/shared/contracts';
import type {ExternalRun,ExternalEvent} from './acp/types';

const at='2026-11-25T01:00:00Z';
const run={id:'run',purpose:'worker',agent:'codex',taskId:'task',rootTurnId:'root'} as ExternalRun;
const operation=():AICard=>({id:'run',type:'operation',at,status:'running',content:'',data:{
 source:'external_agent',external_run_id:'run',external_agent:'codex',root_turn_id:'root',taskId:'task'}});
test('only messages first spoken after a successful work_finish belong to the report handoff',()=>{
 const text=(publicTextId:string):ExternalEvent=>({kind:'text',publicTextId,sequence:1,at});
 const finish:ExternalEvent={kind:'tool_update',title:'work_finish',status:'completed',sequence:2,at};
 const events=[text('stage'),finish,text('stage'),text('closing'),text('closing')];
 assert.deepEqual(codexClosingMessageIds({...run,events}),['closing']);
 assert.deepEqual(codexClosingMessageIds({...run,events:[{...finish,status:'failed'},text('retry')]}),[]);
 assert.deepEqual(codexClosingMessageIds({...run,events,childSessionId:'child'}),[]);
});
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
 assert.equal(hidden?.detail,'cat .env');assert.equal(hidden?.preview,undefined);
 const lines=new CodexOutputBuffer();
 assert.equal(lines.append('-----BEGIN RSA PRIV'),undefined);
 assert.equal(lines.append('ATE KEY-----\nkey bytes\n'),'敏感输出已隐藏');
 assert.equal(lines.append('-----END RSA PRIVATE KEY-----\nsafe\n'),'safe');
});
test('command text keeps newlines, masks literals before clipping, and withholds risky output',()=>{
 const script='pwd\n'+('ls -al\n'.repeat(90))+'date';
 assert.equal(publicCommand(script),script);
 assert.equal(publicCommand("export API_TOKEN='fixture example'\npwd"),'export API_TOKEN=[已脱敏]\npwd');
 assert.equal(publicCommand("tool --token 'fixture value' --list"),"tool --token [已脱敏] --list");
 const scriptWithReference="python3 - <<'PY'\nprint(1)\npassword = get_value('fixture')\nprint(2)\nPY";
 assert.equal(publicCommand(scriptWithReference),scriptWithReference.replace("get_value('fixture')",'[已脱敏]'));
 for(const cmd of ['curl -H "Authorization: Bearer fixture example" https://example.test',
   'echo -----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----',
   'PASSWORD="fixture\ncontinued value"\necho ok','curl https://u:fixture@example.test/']){
   const call=codexToolDetail({type:'commandExecution',command:cmd,aggregatedOutput:'fixture'});
   assert.doesNotMatch(call!.detail,/fixture|continued value/);assert.equal(call!.preview,undefined);
 }
 assert.doesNotMatch(publicCommand('x'.repeat(32765)+'fixture',s=>s.replaceAll('fixture','[已脱敏]')),/fix/);
});
test('historical Bash receipts require unique, fully contained calls, including when calls overlap',()=>{
 const events=(callId:string,start:string,end:string):ExternalEvent[]=>[
   {kind:'tool',callId,displayKind:'command',title:'Bash',detail:'内容已隐藏',status:'running',at:start,sequence:1},
   {kind:'tool_update',callId,displayKind:'command',title:'Bash',detail:'内容已隐藏',status:'completed',at:end,sequence:2}];
 const history={...run,events:events('a','10','30')};
 const receipt={at:'11',completedAt:'29',command:'ls .env'};
 const recover=(record:ExternalRun,rows:typeof receipt[])=>[...legacyCommandBodies(record,rows,s=>s).values()];
 assert.deepEqual(recover(history,[receipt]),['ls .env']);
 assert.deepEqual(recover(history,[receipt,receipt]),[]);
 assert.deepEqual(recover({...history,events:[...history.events,...events('b','20','35')]},[receipt]),[]);
 assert.deepEqual(recover(history,[{...receipt,completedAt:'31'}]),[]);
});
