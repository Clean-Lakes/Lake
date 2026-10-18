// Real transcript with synthetic packet delivery; no backend, model, or resource calls.
import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AITranscript} from '../../src/AIPanel';
import type {SessionSnapshot} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/assistantProse.css';
import '../../src/sreCollaboration.css';
const params=new URLSearchParams(location.search);
document.documentElement.dataset.theme=params.get('theme')==='dark'?'dark':'light';
if(params.has('reduce')){const original=window.matchMedia.bind(window);window.matchMedia=query=>query==='(prefers-reduced-motion: reduce)'?{...original(query),matches:true,addEventListener(){},removeEventListener(){}} as MediaQueryList:original(query)}
window.fetch=async()=>new Response('{}',{status:403});
const base='### 检查进展\n\n| 项目 | 状态 |\n| --- | --- |\n| 服务 | 正常 |\n\n[查看记录](#record)\n\n';
const chunks=['正在核对服务状态与最近日志，新的文本会按实际接收顺序平滑呈现。👩🏽‍💻 ', '当前没有发现新增错误，后续会继续比对历史记录。中文、English 和 e\u0301 都应完整显示。 ', '这一段模拟网络突然返回较大一块内容，显示会短暂追赶，随后平滑补齐。'.repeat(4), '\n\n**结论：** 服务状态正常，原始操作记录已保留。'];
function Fixture(){
 const [text,setText]=useState(base),[running,setRunning]=useState(true),[packets,setPackets]=useState(0),[stats,setStats]=useState({renders:0,tableReplacements:0,linkReplacements:0});
 const box=useRef<HTMLDivElement>(null),timer=useRef<ReturnType<typeof setInterval>|null>(null),counts=useRef({renders:0,tableReplacements:0,linkReplacements:0});
 const clear=()=>{if(timer.current!==null)clearInterval(timer.current);timer.current=null};
 useEffect(()=>{const observer=new MutationObserver(records=>{counts.current.renders++;for(const r of records)for(const node of r.removedNodes)if(node instanceof Element){counts.current.tableReplacements+=Number(node.matches('table'))+node.querySelectorAll('table').length;counts.current.linkReplacements+=Number(node.matches('a'))+node.querySelectorAll('a').length}});observer.observe(box.current!,{childList:true,subtree:true,characterData:true});const clock=setInterval(()=>setStats({...counts.current}),50);return()=>{observer.disconnect();clearInterval(clock);clear()}},[]);
 const start=()=>{clear();setText(base);setRunning(true);setPackets(0);let i=0;timer.current=setInterval(()=>{if(i>=chunks.length){clear();setRunning(false);return}const chunk=chunks[i++]!;setText(t=>t+chunk);setPackets(i)},280)};
 const at='2026-10-18T10:00:00Z';
 const snapshot={session:{id:'stream-fixture',title:'流式文字呈现',tags:[]},resources:[],messages:[],actions:[],terminals:[],ai:{status:running?'running':'completed',cards:[{id:'reply',type:'message',status:running?'running':'done',content:text,at}],cardsOffset:0,totalCards:1},sre:{enabled:false,tasks:[]}} as unknown as SessionSnapshot;
 return <main style={{maxWidth:900,padding:20,margin:'20px auto'}}><h2>流式文字呈现 · 隔离验收</h2><p>模拟网络分块；检查表格、链接与历史正文保持稳定。</p><div style={{display:'flex',flexWrap:'wrap',gap:10,marginBottom:16}}><button onClick={start}>开始流式演示</button><button onClick={()=>{setRunning(true);setText(t=>t+chunks[2]);setPackets(n=>n+1)}}>突发追加</button><button onClick={()=>{clear();setRunning(false)}}>停止生成</button></div><output aria-label="呈现统计" style={{display:'block',overflowWrap:'anywhere',fontSize:12}}>{JSON.stringify({packets,...stats,running,sourceLength:text.length,reducedMotion:params.has('reduce')})}</output><div ref={box} style={{marginTop:24}}><AITranscript snapshot={snapshot}/></div></main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture/></React.StrictMode>);
