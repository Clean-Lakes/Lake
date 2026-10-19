// Recorded fictional output only; no backend or filesystem access.
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
createRoot(document.getElementById('root')!).render(<main style={{maxWidth:900,margin:'32px auto',padding:24}}><AITranscript snapshot={snapshot}/></main>);
