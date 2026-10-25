import assert from 'node:assert/strict';
import test from 'node:test';
import {miniAnomalyLine,miniPreview,miniPreviewRows,miniReadableOutput,miniRecordedEntry,retainMiniPreview,miniExecutionStatus,miniRecordedEntries} from '../src/miniBoxPreview';

test('preview pins the first error and its context while ordinary output advances',()=>{
 const output='starting\nError from server (Forbidden)\nservice-account lacks access\n'+Array.from({length:150},(_,i)=>`worker ${i} ready`).join('\n');
 const preview=miniPreview(output),rows=miniPreviewRows(preview,preview.anomalies[0]);
 assert.equal(rows.length,3);assert.equal(rows[0]!.text,'Error from server (Forbidden)');
 assert.equal(rows[1]!.text,'service-account lacks access');assert.equal(rows[2]!.text,'worker 149 ready');
 assert.ok(miniReadableOutput(output).includes('worker 0 ready'));
});
test('preview compacts repeats and CR progress without conflating newline metrics',()=>{
 const preview=miniPreview('\x1b[32mready\x1b[0m\nready\nready\nloading 10%\rloading 20%\rloading 100%\nCPU 50%\nDisk 90%\n');
 assert.equal(preview.lines[0]!.count,3);
 assert.deepEqual(preview.lines.map(line=>line.text),['ready','loading 100%','CPU 50%','Disk 90%']);
 assert.ok(miniReadableOutput('10%\r20%').includes('10%\n20%'));
 assert.equal(miniReadableOutput('\x1b]0;title\x07text\x1b[31'),'text');
});
test('anomaly hints include stdout and JSON errors without treating empty error fields as failures',()=>{
 for(const line of ['panic: out of memory','Permission denied','command not found','连接超时','{"level":"error","message":"request rejected"}','{"error":{"code":"Forbidden"}}'])assert.ok(miniAnomalyLine(line),line);
 for(const line of ['0 errors; failed=0','no errors found','{"error":null,"message":"ready"}','{"error":false}','worker ready'])assert.equal(miniAnomalyLine(line),false,line);
});
test('observed anomalies survive a bounded tail slide and later appends',()=>{
 const first='ERROR: initial failure\nfirst context\n';
 const initial={output:first,preview:miniPreview(first)};
 const tail='new tail\n';const slid=retainMiniPreview(initial,tail);
 const appended=retainMiniPreview({output:tail,preview:slid},tail+'later success\n');
 assert.equal(appended.anomalies[0]!.text,'ERROR: initial failure');assert.equal(appended.anomalies[0]!.context,'first context');assert.equal(appended.retainedOnly,true);
 assert.equal(retainMiniPreview({output:tail,preview:slid},tail),slid);
 assert.equal(miniPreview('x'.repeat(32768)).retainedOnly,true);
});
test('a recorded host check exposes its command and exit code without inventing a live handle',()=>{
 const entry=miniRecordedEntry({id:'check',type:'operation',title:'inspect_host',status:'completed',at:'',content:JSON.stringify({checks:[{command:'uname -a',output:'Darwin'},{command:'df -h',output:'disk output',exitCode:1}]})});
 assert.equal(entry?.command,'df -h');assert.equal(entry?.output,'disk output');assert.equal(entry?.exitCode,1);
 assert.equal(miniRecordedEntry(undefined),undefined);
 const records=miniRecordedEntries([{id:'check',type:'operation',title:'inspect_host',status:'completed',at:'',content:JSON.stringify({checks:[{command:'uname -a',output:'Darwin'},{command:'df -h',output:'disk output',exitCode:1}]})}]);
 assert.deepEqual(records.map(row=>row.command),['uname -a','df -h']);
});

test('execution truth and text hints remain separate when a command exits or is interrupted',()=>{
 const entry={id:'e',command:'demo',output:'ERROR: observed',status:'completed' as const,exitCode:0};
 const options={entry,card:undefined,stale:false,stopping:false,active:false,anomalies:1,dispatching:false};
 assert.equal(miniExecutionStatus(options),'命令已退出 · 有异常线索');
 assert.equal(miniExecutionStatus({...options,active:true}),'继续执行 · 有异常线索');
 assert.equal(miniExecutionStatus({...options,active:true,anomalies:0}),'AI 正在继续');
 assert.equal(miniExecutionStatus({...options,entry:{...entry,exitCode:2}}),'执行失败');
 assert.equal(miniExecutionStatus({...options,entry:{...entry,exitCode:null}}),'退出状态待核查');
 assert.equal(miniExecutionStatus({...options,entry:{...entry,status:'unknown'},active:true}),'结果待核查');
 assert.equal(miniExecutionStatus({...options,stopping:true}),'用户已终止 · 结果待核查');
 assert.equal(miniExecutionStatus({...options,dispatching:true}),'等待命令派发');
});
