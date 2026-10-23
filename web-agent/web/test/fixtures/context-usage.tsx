// Synthetic usage only. No backend, model, credential or resource requests.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ContextUsage} from '../../src/ContextUsage';
import type {AIContextUsage, AIView} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/sessionPresentation.css';
document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')||'light';
const sample:AIContextUsage={window:1_000_000,windowSource:'provider',budget:900_000,inputBudget:892_000,maxOutput:8000,used:707_000,usedKnown:true,estimated:false,lastRequest:{input:707_000,output:2000,total:709_000,known:true,inputKnown:true,outputKnown:true,cachedInput:700_637}};
function Preview(){
 const [mode,setMode]=useState('normal');
 const context=mode==='unknown'?{...sample,usedKnown:false,lastRequest:undefined}:mode==='over'?{...sample,used:930_000}:mode==='zero'?{...sample,used:0,lastRequest:{input:0,output:0,total:0,known:true,inputKnown:true,outputKnown:true,cachedInput:0}}:mode==='uncached'?{...sample,lastRequest:{...sample.lastRequest!,cachedInput:null}}:sample;
 const view:AIView={session:'context-preview',status:'completed',cards:[],turns:1,profile:'core',cardsOffset:0,totalCards:0,usage:{input:4_000_000,output:60_000,total:4_060_000,known:true},context};
 return <main style={{minHeight:'100dvh',boxSizing:'border-box',padding:24,display:'flex',flexDirection:'column',gap:24}}><h2>上下文用量</h2><nav aria-label="测试数据" style={{display:'flex',flexWrap:'wrap',gap:8}}>{[['normal','正常用量'],['unknown','用量未知'],['over','超过预算'],['zero','实测为零'],['uncached','未返回缓存']].map(([value,label])=><button type="button" className="button secondary" key={value} onClick={()=>setMode(value!)}>{label}</button>)}<button type="button" className="button secondary" onClick={()=>document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'}>切换主题</button></nav><footer style={{marginTop:'auto',display:'flex',justifyContent:'flex-end',alignItems:'center',gap:12,paddingBottom:12}}><ContextUsage view={view} compact/><span>测试模型</span></footer></main>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
