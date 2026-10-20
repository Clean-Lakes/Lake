// Recorded fictional output only; no backend or filesystem access.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AITranscript} from '../../src/AIPanel';
import type {AICard,SessionSnapshot} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/assistantProse.css';
document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')||'light';
const at=(i:number)=>`2026-10-19T12:00:${String(i).padStart(2,'0')}Z`;
const outputs=[['PLAN.md','# 数据迁移方案\n\n## 执行前检查\n\n- 核对目标数据库版本\n- 检查可用磁盘空间\n- 确认备份可以恢复\n\n## 回滚\n\n通过 [恢复脚本](scripts/restore.sh) 恢复演示备份。\n\n| 阶段 | 验证 |\n| --- | --- |\n| 导出 | 文件完整 |\n| 恢复 | 行数核对 |'],['k8s/db-all.yaml','apiVersion: v1\nkind: Namespace\nmetadata:\n  name: migration-demo\n'],['scripts/restore.sh','#!/bin/sh\n# 演示脚本，仅供预览，不执行命令\nprintf "Restore requires explicit approval\\n"\n']];
const cards:AICard[]=outputs.map(([path,after],i)=>({id:`file-${i}`,type:'diff',title:'/srv/migration/'+path,status:'completed',at:at(i+1),data:{before:'',after,existed:false,runtime:'ssh',assetRef:'fixture-host'}}));
cards.push({id:'reply',type:'message',status:'completed',at:at(5),content:'方案与配套脚本已保存，包含执行前检查、验证步骤和回滚路径。\n\n当前只生成了文件，尚未执行部署。'});
const snapshot={session:{id:'fixture'},resources:[{id:'fixture-host',name:'演示主机',kind:'ssh'}],messages:[{id:'user',role:'user',text:'先给出迁移方案和脚本。',createdAt:at(0)}],actions:[],ai:{session:'fixture',status:'completed',cards,cardsOffset:0,totalCards:cards.length,turns:1}} as SessionSnapshot;
const params=new URLSearchParams(location.search);
const metrics={fileArrivals:0,durations:[] as number[]};
const proof=document.createElement('output');proof.dataset.testid='file-arrival-proof';proof.hidden=true;document.body.appendChild(proof);
const report=()=>{proof.textContent=JSON.stringify(metrics);};report();
document.addEventListener('animationstart',event=>{if((event.target as HTMLElement).classList.contains('turn-files')){metrics.fileArrivals++;metrics.durations.push(Number.parseFloat(getComputedStyle(event.target as Element).animationDuration));report();}});
function Preview(){
 const [done,setDone]=useState(!params.has('lifecycle')),[revision,setRevision]=useState(0),[activity,setActivity]=useState(false),[restored,setRestored]=useState(0);
 const shown={...snapshot,ai:{...snapshot.ai!,status:done?'completed':'running',cards:snapshot.ai!.cards.map(card=>card.id==='file-0'?{...card,data:{...(card.data as object),after:outputs[0]![1]+('\n补充验证记录。'.repeat(revision))}}:card)}};
 return <main style={{maxWidth:900,margin:'32px auto',padding:24}}>{params.has('lifecycle')&&<nav style={{display:'flex',gap:8,marginBottom:20}}><button className="button secondary" onClick={()=>setDone(true)}>结束本轮</button><button className="button secondary" onClick={()=>setRevision(n=>n+1)}>更新文件记录</button><button className="button secondary" onClick={()=>setActivity(v=>!v)}>切换执行记录</button><button className="button secondary" onClick={()=>{setDone(true);setRestored(n=>n+1);}}>恢复历史</button></nav>}<AITranscript key={restored} snapshot={shown} mode={activity?'activity':'conversation'}/></main>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
