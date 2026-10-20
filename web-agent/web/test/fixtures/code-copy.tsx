// Isolated UI fixture: no backend, model calls or command execution.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AITranscript} from '../../src/AIPanel';
import {SREProse} from '../../src/SREReport';
import type {SessionSnapshot} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/assistantProse.css';
import '../../src/sreCollaboration.css';
import '../../src/conversationDirectory.css';
const query=new URLSearchParams(location.search);
document.documentElement.dataset.theme=query.get('theme')||'light';
const command='cd /d E:\\map\\示例目录\n"C:\\Program Files\\7-Zip\\7z.exe" a -t7z -mx=1 -ms=off -mmt=8 -bsp1 -bb1 "E:\\map\\示例目录-1-14.7z" 1 2 3 4 5 6 7 8 9 10 11 12 13 14\n';
const singleCommand='git push origin codex/sre-collaboration:master\n';
const body='行内 `echo 示例` 保持原样。\n\n```bash\n'+singleCommand+'```\n\n```bat\n'+command+'```\n\n```json\n{"message":"<script> & \\\"中文\\\"","count":14}\n```\n\n右侧仅保留复制按钮，长命令在代码区内滚动。';
const snapshot={session:{id:'fixture'},messages:[],actions:[],resources:[],ai:{session:'fixture',status:'completed',cardsOffset:0,turns:1,cards:[{id:'reply',type:'message',content:body,status:'completed',at:'2026-10-20T03:00:00Z'}]}} as SessionSnapshot;
function Fixture(){
 const [sre,setSRE]=useState(false),[paste,setPaste]=useState('');
 if(query.has('preview'))return <main style={{padding:20}}><SREProse>{'```bash\n'+singleCommand+'```'}</SREProse></main>;
 return <main style={{width:'100%',maxWidth:query.has('narrow')?360:850,margin:'24px auto',padding:'0 16px',height:'calc(100% - 48px)',overflow:'auto'}}>
  <h1>代码块复制</h1><button onClick={()=>setSRE(v=>!v)}>{sre?'查看普通回复':'查看 SRE 报告'}</button>
  {sre?<SREProse>{body}</SREProse>:<AITranscript snapshot={snapshot}/>}
  <label>粘贴校验<textarea aria-label="粘贴校验" value={paste} onChange={event=>setPaste(event.target.value)} style={{width:'100%',height:120}}/></label>
  <p role="status">{paste?[command,singleCommand].includes(paste)?'内容完全一致':'内容不一致':'等待粘贴'}</p>
 </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
