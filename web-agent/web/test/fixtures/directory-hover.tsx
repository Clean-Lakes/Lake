// Isolated navigation fixture; no host, model or backend requests.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ConversationDirectory,conversationTurnId} from '../../src/ConversationDirectory';
import '../../src/styles.css';
import '../../src/conversationDirectory.css';
document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')||'light';
const labels=['检查服务器当前状态','定位负载升高的原因','比较前后两次采样','确认容器健康检查','查看服务日志中的异常','核对文件传输结果'];
const items=Array.from({length:20},(_,i)=>({id:`u${i}`,number:i+1,label:i===2?'检查一下这个圆角是否一致':`${labels[i%labels.length]}${i===19?'，保留原始记录并说明尚未确认的情况':''}`,summary:i===2?'不完全一致，截图中窗口外角更圆，输入框略偏方。\n\n- 窗口圆角由系统绘制。\n- 输入框使用独立的圆角尺寸。':'已核对本轮记录，完整操作过程保留。\n\n- 关键指标已采集。\n- 尚未确认的情况仍需进一步检查。'}));
function Fixture(){
 const [inspections,setInspections]=useState(0),[jump,setJump]=useState('无');
 const move=(id:string)=>{setJump(id);document.getElementById(conversationTurnId('fixture',id))?.scrollIntoView({block:'start'})};
 return <div style={{height:'100%',display:'flex',flexDirection:'column'}}>
  <header style={{padding:16,borderBottom:'1px solid var(--border)',fontSize:12}}><button onClick={()=>{}}>测试区外</button><output style={{marginLeft:12}}>固定目录次数：{inspections} · 最近跳转：{jump}</output></header>
  <main className="conversation" style={{flex:1,minHeight:0,overflow:'auto',padding:24}}>
   <div className="timeline-list" style={{margin:'auto',maxWidth:860,paddingLeft:28}}>{items.map(item=><section id={conversationTurnId('fixture',item.id)} key={item.id} style={{minHeight:180,padding:'8px 0 24px'}}><p style={{margin:'0 0 18px',fontSize:14}}>{item.label}</p><p style={{color:'var(--text-secondary)',fontSize:13}}>进展与操作在两行内更新，完整过程可展开。</p><p style={{color:'var(--text-muted)',fontSize:12}}>第 {item.number} 轮 · 隔离预览</p></section>)}</div>
  </main>
  <ConversationDirectory sessionId="fixture" items={items} onOpen={()=>setInspections(n=>n+1)} onJump={move} onLatest={()=>move(items.at(-1)!.id)}/>
 </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
