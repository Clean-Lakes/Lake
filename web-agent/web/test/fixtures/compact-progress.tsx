// Synthetic transcript only: no backend, host or model calls.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AITranscript} from '../../src/AIPanel';
import type {AICard,SessionSnapshot} from '../../../shared/contracts';
import '../../src/theme.css';
import '../../src/styles.css';
import '../../src/assistantProse.css';
import '../../src/statusText.css';
import '../../src/conversationDirectory.css';
document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')||'light';
const start=Date.now()-10000;
const time=(i:number)=>new Date(start+i*100).toISOString();
const notes=['我先获取可用的服务器连接，然后发起一轮新的只读检查。','负载明显高于基线，我先定位原因并同时核对容器状态。','没有 D 状态进程，需要观察瞬时指标才能判断负载峰值。','CPU 空闲但负载上升，我再采样一分钟确认进程变化。'];
const round=(i:number):AICard[]=>[{id:`note${i}`,type:'message',content:notes[i%notes.length],status:'completed',at:time(i*2+1)},{id:`tool${i}`,type:'operation',title:'shell',content:`采样 ${i} 的完整原始记录`,status:'completed',at:time(i*2+2),data:{target:'隔离测试主机',arguments:{command:i%2?'ps aux':'uptime; free -m'}}}];
function Fixture(){
 const [count,setCount]=useState(4),[done,setDone]=useState(false),[attention,setAttention]=useState(false),[activity,setActivity]=useState(false);
 const cards=Array.from({length:count},(_,i)=>round(i)).flat();
 if(!done)cards.at(-1)!.status='running';
 if(attention)cards.push({id:'uncertain',type:'operation',title:'shell',status:'unknown',content:'等待超时，变更结果不明',at:time(count*2+1),data:{arguments:{command:'example-change'}}});
 if(done)cards.push({id:'final',type:'message',status:'completed',at:time(count*2+2),content:'检查结束：服务指标已采集。\n\n| 项目 | 观察 |\n| --- | --- |\n| CPU | 空闲 |\n\n完整原始采样保留在执行过程中。'});
 const snapshot={session:{id:'fixture'},messages:[{id:'user',role:'user',text:'再检查一遍服务器的状态',createdAt:time(0)}],actions:[],resources:[],ai:{session:'fixture',status:done?'completed':'running',turnStartedAt:time(0),turnFinishedAt:done?time(count*2+2):undefined,cards,cardsOffset:0,totalCards:cards.length,turns:1}} as SessionSnapshot;
 return <><div className="fixture-controls"><button onClick={()=>setCount(n=>n+1)}>下一步</button><button onClick={()=>setDone(true)}>完成回复</button><button onClick={()=>setAttention(v=>!v)}>切换不明结果</button><button onClick={()=>setActivity(v=>!v)}>切换执行记录</button><output>已保留 {count} 条过程说明和 {count} 项原始操作</output></div><main><AITranscript snapshot={snapshot} mode={activity?'activity':'conversation'}/></main></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
