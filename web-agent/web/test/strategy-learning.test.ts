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

test('comparison display preserves malformed output and extracts only the visible answer',async()=>{
 const {strategyExperimentAnswer}=await import('../src/strategyApi');
 assert.equal(strategyExperimentAnswer(JSON.stringify({finding:'deleted_open_file',answer:'Observed evidence',evidenceIds:['observation-1']})),'Observed evidence');
 assert.equal(strategyExperimentAnswer('partial output'),'partial output');
 assert.equal(strategyExperimentAnswer('{"answer":false}'),'{"answer":false}');
});
test('experiments send precise version, case IDs and paired repetitions without authority claims',async()=>{
 const {strategyExperimentApi}=await import('../src/strategyApi');const oldFetch=globalThis.fetch;let submitted:Record<string,unknown>={};
 globalThis.fetch=async (_url,options)=>{submitted=JSON.parse(String(options?.body));return new Response('{"jobId":"experiment"}',{status:200});};
 try{await strategyExperimentApi.create('/api/projects/project/strategy',{assetId:'asset',revision:2,contentHash:'exact-hash'},['SL-013'],3,['handwritten']);assert.deepEqual(submitted,{ref:{assetId:'asset',revision:2,contentHash:'exact-hash'},caseIds:['SL-013'],repetitions:3,skillNames:['handwritten']});}finally{globalThis.fetch=oldFetch;}
});

test('retired optimizer exposes no create, resume or candidate-save client action',async()=>{
 const {strategyExperimentApi}=await import('../src/strategyApi');
 for(const key of ['optimize','resume','saveCandidate'])assert.ok(!(key in strategyExperimentApi));
 assert.equal(typeof strategyExperimentApi.report,'function');assert.equal(typeof strategyExperimentApi.erase,'function');
});
