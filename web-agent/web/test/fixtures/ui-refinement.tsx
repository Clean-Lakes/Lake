import {createRoot} from 'react-dom/client';
import {AITranscript} from '../../src/AIPanel';
import {ReplyDuration} from '../../src/ReplyDuration';
import {DisclosureSummary} from '../../src/DisclosureSummary';
import {PendingMessages} from '../../src/PendingMessages';
import {AgentQuestion} from '../../src/AgentQuestion';
import type {SessionSnapshot,AIQuestionRequest,MessageQueue,ReplyTiming} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/assistantProse.css';
import '../../src/agentQuestion.css';
document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')||'light';
const at='2026-10-18T10:00:00Z';
const content='## 结论先行\n\n现有采样未发现新增故障，负载读数的变化更可能来自残留健康检查单元的周期触发，暂未见持续的 CPU、内存或磁盘压力。\n\n最后一次检查未完成，后续状态仍待确认。\n\n### 一、基础健康\n\n| 项目 | 观察 |\n| --- | --- |\n| 负载 | 2.70 |\n\n'+('这是原始采样依据，不代表新一次检查已经成功。\n\n').repeat(40);
const snapshot={session:{id:'fixture'},messages:[],resources:[],actions:[],ai:{session:'fixture',status:'completed',turns:1,cardsOffset:0,cards:[{id:'reply',type:'message',status:'completed',content,at}]}} as SessionSnapshot;
const timing:ReplyTiming={messageId:'u',startedAt:at,finishedAt:'2026-10-18T10:00:11Z',status:'completed'};
const queue:MessageQueue={paused:false,revision:1,lastError:'',items:[{id:'pending-1',text:'对比前后两次采样，确认负载变化。',resourceIds:[],images:[],files:[],createdAt:at}]};
const request={id:'question',questions:[{id:'q',title:'这次检查要覆盖哪些主机？',reason:'确认范围后继续只读检查。',options:[{label:'当前主机',description:'继续检查已选资源',recommended:true},{label:'项目内全部主机',description:'检查当前项目中的 SSH 主机'}]}]} as AIQuestionRequest;
createRoot(document.getElementById('root')!).render(<main style={{maxWidth:820,margin:'24px auto',padding:'0 24px',height:'calc(100% - 48px)',overflow:'auto'}}>
 <AITranscript snapshot={snapshot}/><ReplyDuration timing={timing}/>
 <details><DisclosureSummary>执行记录 · 3 项</DisclosureSummary><p>原始操作记录保留，可按需核对。</p></details>
 <div style={{marginTop:24}}><PendingMessages sessionId="fixture" queue={queue} disabled={true} active={true} sendShortcut="enter" resourceIds={()=>[]} onUpdated={()=>{}}/></div>
 <AgentQuestion session="fixture" request={request} refresh={async()=>{}}/>
 <ReplyDuration timing={{...timing,status:'failed'}}/>
 <ReplyDuration timing={timing} cards={[{id:'uncertain',at,type:'operation',status:'unknown'}]}/>
</main>);
