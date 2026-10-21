import assert from 'node:assert/strict';
import test from 'node:test';
import {strategyLearningApi} from '../src/strategyApi';

test('proposal requests preserve idempotency on transport ambiguity and exclude authority claims',async()=>{
 const oldFetch=globalThis.fetch;const seen:{key:string;body:Record<string,unknown>}[]=[];
 globalThis.fetch=async (_url,options)=>{const h=options?.headers as Record<string,string>;seen.push({key:h['Idempotency-Key'],body:JSON.parse(String(options?.body))});if(seen.length===1)throw new TypeError('network interrupted');return new Response(JSON.stringify({jobId:'stable-job'}),{status:200});};
 try {await assert.rejects(strategyLearningApi.propose('/api/projects/project/strategy',['genuine-source']));assert.deepEqual(await strategyLearningApi.propose('/api/projects/project/strategy',['genuine-source']),{jobId:'stable-job'});assert.equal(seen[0].key,seen[1].key);assert.deepEqual(seen[1].body,{sourceIds:['genuine-source'],assetId:'',expectedRevision:0});assert.ok(seen[0].key);}finally{globalThis.fetch=oldFetch;}
});
test('source registration and withdrawal use real message references and explicit scoped endpoints',async()=>{
 const oldFetch=globalThis.fetch;const requests:{url:string;method:string;body:unknown}[]=[];
 globalThis.fetch=async (url,options)=>{requests.push({url:String(url),method:String(options?.method),body:JSON.parse(String(options?.body))});return new Response('{}',{status:200});};
 try{await strategyLearningApi.register('/api/projects/project/strategy','actual-message');await strategyLearningApi.withdraw('/api/projects/project/strategy','source/id');await strategyLearningApi.cancel('/api/projects/project/strategy','job/id');assert.deepEqual(requests,[{url:'/api/projects/project/strategy/sources',method:'POST',body:{messageId:'actual-message'}},{url:'/api/projects/project/strategy/sources/source%2Fid',method:'DELETE',body:{}},{url:'/api/projects/project/strategy/proposals/job%2Fid/cancel',method:'POST',body:{}}]);}finally{globalThis.fetch=oldFetch;}
});
