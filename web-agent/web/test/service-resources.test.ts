import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyServiceDraft,serviceResourceInput,resourceTypeLabel,resourceTypeOptions} from '../src/serviceResourceModel';
import {mentionOptions,mentionTypeLabel} from '../src/composerMentionState';
import type {Resource} from '../../shared/contracts';

test('type changes initialize correct ports and clear all secret drafts',()=>{
 for(const [type] of resourceTypeOptions){const draft=emptyServiceDraft(type);assert.equal(draft.password,'');assert.equal(draft.token,'');assert.equal(draft.apiKey,'');if(type==='mysql')assert.equal(draft.port,3306);if(type==='postgres')assert.equal(draft.port,5432);if(type==='redis')assert.equal(draft.port,6379)}
});
test('service payloads isolate fields and retain VictoriaMetrics tenant query prefix',()=>{
 const draft={...emptyServiceDraft(),host:' db.example ',password:'synthetic-password',token:'synthetic-token',apiKey:'synthetic-key',endpoint:' https://vm.example/select/2/prometheus '};
 assert.deepEqual(serviceResourceInput('mysql',draft),{kind:'database',settings:{driver:'mysql',host:'db.example',port:5432,username:'',database:'',tls:true,sslmode:'verify-full',password:'synthetic-password'}});
 for(const type of ['kubernetes','apisix','victoriametrics'] as const){const input=serviceResourceInput(type,draft);assert.equal(input.kind,type);assert.equal(input.settings.endpoint,'https://vm.example/select/2/prometheus');assert.ok(!('host' in input.settings));if(type==='kubernetes')assert.ok(!('password'in input.settings));if(type==='apisix')assert.ok(!('token'in input.settings))}
});
test('new kinds have explicit detail and mention labels',()=>{
 for(const kind of ['kubernetes','apisix','prometheus','victoriametrics'] as const){const r:Resource={id:kind,kind,projectId:'p',name:'test',description:'',status:'available'};assert.ok(resourceTypeLabel(r));assert.notEqual(mentionTypeLabel(mentionOptions([r],[],[])[0]!),'资源')}
 assert.equal(resourceTypeLabel({kind:'database',settings:{driver:'mysql'}}),'MySQL');assert.equal(resourceTypeLabel({kind:'database',settings:{driver:'postgres'}}),'PostgreSQL');
});
