// Isolated browser regression: real SRE components, no backend or resource access.
import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SREProse} from '../../src/SREReport';
import {SREActivity} from '../../src/SREActivity';
import {FollowScroll} from '../../src/followScroll';
import type {AgentRun} from '../../../shared/contracts';
import '../../src/theme.css';
import '../../src/styles.css';
import '../../src/sreCollaboration.css';
import '../../src/statusText.css';
const report='### 检查结论\n\n服务运行正常，继续核对异常日志。\n\n| 项目 | 状态 |\n| --- | --- |\n| CPU | 正常 |\n| 内存 | 正常 |\n\n[查看证据](#evidence)';
const startedAt=new Date(Date.now()-57000).toISOString();
function Fixture(){
 const [revision,setRevision]=useState(0),[stream,setStream]=useState(''),[stats,setStats]=useState({replacements:0,scrolls:0,top:0,ticks:0,elapsed:''});
 const latestRevision=useRef(0);latestRevision.current=revision;
 const box=useRef<HTMLDivElement>(null),follower=useRef<FollowScroll|null>(null),following=useRef(true),counts=useRef({replacements:0,scrolls:0});
 useLayoutEffect(()=>{const node=box.current!;const follow=new FollowScroll(node,()=>following.current);follower.current=follow;follow.jump();
 const observer=new ResizeObserver(()=>follow.request());observer.observe(node.firstElementChild!);
 const mutations=new MutationObserver(records=>{for(const r of records)for(const n of r.removedNodes)if(n instanceof Element)counts.current.replacements+=n.matches('table,a')?1:n.querySelectorAll('table,a').length;});
 mutations.observe(node,{childList:true,subtree:true});
 const scroll=()=>{counts.current.scrolls++};node.addEventListener('scroll',scroll);
 return()=>{follow.stop();observer.disconnect();mutations.disconnect();node.removeEventListener('scroll',scroll)};
 },[]);
 useEffect(()=>{const timer=setInterval(()=>setRevision(n=>n+1),120);return()=>clearInterval(timer)},[]);
 useLayoutEffect(()=>{follower.current?.request()},[revision]);
 useEffect(()=>{const timer=setInterval(()=>setStats({...counts.current,top:box.current!.scrollTop,ticks:latestRevision.current,elapsed:box.current!.querySelector('.sre-live-activity time')?.textContent??''}),500);return()=>clearInterval(timer)},[]);
 const run={id:'fixture',status:'running',startedAt,createdAt:startedAt,activityPhase:'thinking',toolCount:13,evidence:[]} as AgentRun;
 return <main style={{maxWidth:850,margin:'24px auto',padding:20}}><h2>SRE 更新稳定性 · 隔离测试数据</h2><p>每 120ms 模拟一次快照；专员计时保持运行。滚动区内表格与链接应保持原节点。</p><output data-testid="stats">{JSON.stringify(stats)}</output><p>快照 {revision}</p><div style={{display:'flex',gap:12,marginBottom:12}}><button onClick={()=>{following.current=false;box.current!.scrollTop=200}}>阅读历史</button><button onClick={()=>{following.current=true;follower.current?.jump()}}>跟随最新</button><button onClick={()=>setStream(old=>old+'\n\n新采集的证据已更新。')}>追加消息</button></div><div ref={box} tabIndex={0} style={{height:420,overflow:'auto',border:'1px solid var(--border)',padding:20}}><div>{Array.from({length:5},(_,i)=><SREProse key={i}>{report}</SREProse>)}<h4>调查员 · 执行中</h4><SREProse>{report+stream}</SREProse><SREActivity run={run}/></div></div></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
