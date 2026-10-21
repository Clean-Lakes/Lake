import assert from 'node:assert/strict';
import test from 'node:test';
import {parseStrategyImport,strategyExport,strategyPath} from '../src/strategyApi';

test('portable strategy import creates content without restoring authority or adoption',()=>{
 const data={format:'lake-strategy-v1',title:'Evidence',kind:'domain_procedure',body:'Collect fresh evidence.',applicability:{profiles:['core'],resourceKinds:['ssh'],domainTags:[]},verified:true,actor:'system',scope:{kind:'user'},sourceIds:['forged-source'],enabled:true,revision:900};
 const draft=parseStrategyImport(JSON.stringify(data));
 assert.deepEqual(Object.keys(draft).sort(),['applicability','body','kind','title']);
 const exported=JSON.parse(strategyExport(draft));assert.equal(exported.format,'lake-strategy-v1');assert.equal(exported.body,data.body);assert.equal(exported.verified,undefined);assert.equal(exported.sourceIds,undefined);
});
test('portable strategy import rejects malformed content and excessive file size',()=>{
 for(const input of ['null','[]','{}',JSON.stringify({format:'lake-strategy-v1',title:'x',kind:'permissions',body:'x'}),JSON.stringify({format:'lake-strategy-v1',title:'x',kind:'user_preference',body:'x',applicability:{profiles:'core'}}),'x'.repeat(128001)])assert.throws(()=>parseStrategyImport(input));
});
test('strategy scope is explicit and project identifiers are encoded',()=>{
 assert.equal(strategyPath(''),'/api/strategy');assert.equal(strategyPath('project/one'),'/api/projects/project%2Fone/strategy');
});
