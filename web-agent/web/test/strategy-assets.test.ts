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

test('assessment notes survive portable export without project lineage or verification claims',()=>{
 const draft=parseStrategyImport(JSON.stringify({format:'lake-strategy-v1',title:'Evidence',kind:'report_guidance',body:'State observations first.',applicability:{profiles:[],resourceKinds:[],domainTags:[]},assessment:{conditions:'Readonly checks',evidence:'User reviewed on 2026-10-23',limitations:'Does not prove recovery'},originProject:'private',sourceIds:['private'],review:{decision:'accepted'}}));
 assert.deepEqual(draft.assessment,{conditions:'Readonly checks',evidence:'User reviewed on 2026-10-23',limitations:'Does not prove recovery'});
 const exported=JSON.parse(strategyExport(draft));assert.equal(exported.originProject,undefined);assert.equal(exported.sourceIds,undefined);assert.equal(exported.review,undefined);
});

test('review and promotion send exact revision and explicit preview only',async()=>{
 const {strategyApi}=await import('../src/strategyApi');const oldFetch=globalThis.fetch;const seen:{url:string;body:unknown}[]=[];
 globalThis.fetch=async(url,options)=>{seen.push({url:String(url),body:JSON.parse(String(options?.body))});return new Response('{}',{status:200});};
 try{const base='/api/projects/A/strategy';const ref={assetId:'asset/id',revision:2,contentHash:'exact'};const draft={title:'General method',kind:'user_preference' as const,body:'Reviewed public text',applicability:{profiles:[],resourceKinds:[],domainTags:[]},assessment:{conditions:'General',evidence:'User statement',limitations:'No guarantee'}};await strategyApi.review(base,ref,3,'rejected','too_specific');await strategyApi.promote(base,ref,draft,true);assert.deepEqual(seen,[{url:base+'/assets/asset%2Fid/review',body:{ref,expectedDecisionRevision:3,decision:'rejected',reasonCode:'too_specific'}},{url:base+'/assets/asset%2Fid/promote',body:{ref,confirmed:true,draft:{...draft,expectedRevision:0}}}]);}finally{globalThis.fetch=oldFetch;}
});


test('promotion entry requires saved, accepted source and explains explicit public preview',async()=>{
 const {createElement}=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');const {StrategyPromotion}=await import('../src/StrategyPromotion');
 const ref={assetId:'candidate',revision:1,contentHash:'exact'};const draft={title:'Private original',kind:'user_preference' as const,body:'Project preference',applicability:{profiles:[],resourceKinds:[],domainTags:[]}};
 const selected={asset:{id:'candidate',revision:1,title:draft.title,kind:draft.kind,scope:{kind:'project' as const,projectId:'private'},deleted:false},value:{ref,parentRevision:0,kind:draft.kind,body:draft.body,applicability:draft.applicability,verification:'single_observation',sourceIds:['private-source']},available:true,sourcesAvailable:true,assessment:{conditions:'',evidence:'',limitations:''},review:{decision:'pending',decisionRevision:0,reasonCode:''}};
 const html=renderToStaticMarkup(createElement(StrategyPromotion,{selected,draft,busy:false,confirm:()=>{},onSaved:()=>{}}));assert.match(html,/先保存并确认最新版本正文/);assert.match(html,/准备跨项目版本<\/button>/);assert.match(html,/原始项目消息及来源摘要不会复制/);assert.ok(!html.includes('private-source'));assert.ok(!html.includes('private'));
});
