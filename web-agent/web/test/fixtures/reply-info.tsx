// Fictional display data only; no backend, model or command requests.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AITranscript} from '../../src/AIPanel';
import {SREProse} from '../../src/SREReport';
import type {SessionSnapshot} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/assistantProse.css';
import '../../src/sreCollaboration.css';
import '../../src/conversationDirectory.css';
const params=new URLSearchParams(location.search);
document.documentElement.dataset.theme=params.get('theme')||'light';
const file=params.has('long')?'docs/跨区域生产环境与多集群故障恢复验证记录/README.md':'profile/README.md';
const body='## 已恢复仓库并更新组织主页\n\nREADME 已恢复，组织介绍已更新。临时 worktree 和分支已清理。\n\n提交：`86a30431` 回滚 `062cb970`\n\n分支：`origin/master` · `main`\n\n检查：14个文件 · 1.8秒 · 无冲突\n\n['+file+'](https://github.com/Clean-Lakes/.github/blob/main/profile/README.md)';
const snapshot={session:{id:'summary-preview'},messages:[],actions:[],resources:[],ai:{session:'summary-preview',status:'completed',cardsOffset:0,turns:1,cards:[{id:'reply',type:'message',content:body,status:'completed',at:'2026-10-20T00:00:00Z'}]}} as SessionSnapshot;
function Fixture(){
 const [sre,setSRE]=useState(params.has('sre'));
 const [pasted,setPasted]=useState('');
 return <main style={{maxWidth:640,padding:params.has('capture')?20:24,margin:params.has('capture')?0:'0 auto',height:'100%',overflow:'auto'}}>
  {!params.has('capture')&&<button onClick={()=>setSRE(value=>!value)}>{sre?'查看普通回复':'查看 SRE 正文'}</button>}
  {sre?<SREProse>{body}</SREProse>:<AITranscript snapshot={snapshot}/>}
  {!params.has('capture')&&<label>复制校验<input aria-label="复制校验" value={pasted} onChange={event=>setPasted(event.target.value)}/><span role="status">{pasted==='86a30431'?'提交号完全一致':pasted?'待核对':'等待复制'}</span></label>}
 </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
