import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeChannelEntries} from '../src/SpecialistChannel';
import type {SpecialistChannelEntry} from '../../shared/contracts';

test('channel pagination and retries use source identity rather than report body',()=>{
 const entry=(id:string,at:string,source='worker-a'):SpecialistChannelEntry=>({id,sourceSessionId:source,taskId:`task-${source}`,createdAt:at,message:{id,sessionId:source,role:'assistant',text:'相同正文',createdAt:at}});
 const newer=entry('a','2026-11-03T01:00:01Z'),older=entry('b','2026-11-03T01:00:00Z','worker-b');
 const updated={...newer,message:{...newer.message!,text:'流式更新'}};
 const result=mergeChannelEntries([newer],[older,updated]);
 assert.deepEqual(result.map(item=>item.id),['b','a']);
 assert.equal(result[0]?.sourceSessionId,'worker-b');assert.equal(result[1]?.message?.text,'流式更新');
 assert.equal(mergeChannelEntries(result,[older]).length,2);
});
