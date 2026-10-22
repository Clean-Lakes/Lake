import test from 'node:test';
import assert from 'node:assert/strict';
import {currentReasoningLabel} from '../src/reasoningLabels';
test('toolbar level uses this model capability response, including its actual default',()=>{
 const setting={modelId:'flash',levels:['none','low','high','max'],default:'high',effort:''};
 assert.equal(currentReasoningLabel(setting,'flash'),'高');
 assert.equal(currentReasoningLabel({...setting,effort:'low'},'flash'),'低');
 assert.equal(currentReasoningLabel({...setting,effort:'none'},'flash'),'关闭');
 assert.equal(currentReasoningLabel({...setting,modelId:'pro',levels:['low','max'],default:'max'},'pro'),'最高');
 assert.equal(currentReasoningLabel(setting,'pro'),undefined,'a previous model cannot supply the new badge');
 assert.equal(currentReasoningLabel({...setting,effort:'ultra'},'flash'),undefined,'unsupported levels are never invented');
 assert.equal(currentReasoningLabel({...setting,levels:[]},'flash'),undefined);
 assert.equal(currentReasoningLabel(undefined,'flash'),undefined);
});
