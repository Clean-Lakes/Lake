import assert from 'node:assert/strict';
import test from 'node:test';
import {reasoningSaveQueue,type ReasoningSaveRequest} from '../src/reasoningSaveQueue';
import type {ReasoningSettings} from '../../shared/contracts';
function setup(){
 const requests:ReasoningSaveRequest[]=[],busy:boolean[]=[],saved:Array<{effort:string;next:boolean}>=[],failed:Array<{effort:string;next:boolean}>=[];
 const gates:Array<{resolve:(value:ReasoningSettings)=>void;reject:(error:unknown)=>void}>=[];
 const queue=reasoningSaveQueue(request=>{requests.push(request);return new Promise((resolve,reject)=>gates.push({resolve,reject}));},{busy:value=>busy.push(value),saved:(request,_result,next)=>saved.push({effort:request.effort,next}),failed:(request,_error,next)=>failed.push({effort:request.effort,next})});
 const enqueue=(effort:string,modelId='model',session='session')=>queue.enqueue({session,modelId,effort});
 const resolve=async(index:number)=>{gates[index]!.resolve({modelId:requests[index]!.modelId,effort:requests[index]!.effort,levels:['low','high','max']});await Promise.resolve();};
 return {queue,requests,busy,saved,failed,gates,enqueue,resolve};
}
test('rapid slider changes serialize and coalesce; busy does not flash between saves',async()=>{
 const s=setup();s.enqueue('low');s.enqueue('high');s.enqueue('max');
 assert.deepEqual(s.requests.map(r=>r.effort),['low']);assert.deepEqual(s.busy,[true]);
 await s.resolve(0);assert.deepEqual(s.requests.map(r=>r.effort),['low','max']);assert.deepEqual(s.busy,[true]);
 await s.resolve(1);assert.deepEqual(s.saved,[{effort:'low',next:true},{effort:'max',next:false}]);assert.deepEqual(s.busy,[true,false]);assert.equal(s.queue.busy,false);
});
test('returning to an in-flight value cancels a superseded queued value',async()=>{
 const s=setup();s.enqueue('high');s.enqueue('max');s.enqueue('high');await s.resolve(0);
 assert.equal(s.requests.length,1);assert.deepEqual(s.saved,[{effort:'high',next:false}]);assert.deepEqual(s.busy,[true,false]);
});
test('a failed older write does not discard the latest desired default',async()=>{
 const s=setup();s.enqueue('high');s.enqueue('');s.gates[0]!.reject(new Error('temporary failure'));await Promise.resolve();
 assert.deepEqual(s.failed,[{effort:'high',next:true}]);assert.deepEqual(s.requests.map(r=>r.effort),['high','']);assert.deepEqual(s.busy,[true]);
 await s.resolve(1);assert.deepEqual(s.saved,[{effort:'',next:false}]);assert.deepEqual(s.busy,[true,false]);
});
test('a final failure releases busy and later attempts can recover',async()=>{
 const s=setup();s.enqueue('max');s.gates[0]!.reject(new Error('save failed'));await Promise.resolve();
 assert.deepEqual(s.failed,[{effort:'max',next:false}]);assert.equal(s.queue.busy,false);
 s.enqueue('low');await s.resolve(1);assert.deepEqual(s.busy,[true,false,true,false]);assert.equal(s.saved[0]!.effort,'low');
});
test('same effort in a different model or session is a separate write',async()=>{
 const s=setup();s.enqueue('high');s.enqueue('high','other','other-session');await s.resolve(0);await s.resolve(1);
 assert.deepEqual(s.requests.map(r=>[r.session,r.modelId]),[['session','model'],['other-session','other']]);
});
