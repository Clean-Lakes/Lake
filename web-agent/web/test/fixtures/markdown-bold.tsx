// Screenshot-shaped generated prose; no backend or model requests.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AITranscript} from '../../src/AIPanel';
import {SREProse} from '../../src/SREReport';
import type {SessionSnapshot} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/assistantProse.css';
import '../../src/sreCollaboration.css';
import '../../src/conversationDirectory.css';
document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')||'light';
const body='## 结论先行\n\n**服务器本体是健康的，本轮唯一实质变化是“负载读数”从 0.04 涨到 2 上下——但它不是真实压力，是 3 个残留健康检查单元制造出来的读数虚高。 **没有新增故障、没有容器异常、没有内存或磁盘变化。\n\n不过要说明：**这一轮采集在最后一步被运行环境拦住了**，下面是已经拿到的实测数据，后续检查仍有待确认项。\n\n### 一、基础健康（隔离展示数据）\n\n| 项 | 现在 | 对比基线 |\n| --- | --- | --- |\n| CPU | **空闲。 ** | 未见持续压力 |\n| 运行时长 | 97 天 | 正常增长 |\n\n**systemd 启动频率限流（startLimit） **把重试压住了。\n\n- **磁盘： **使用 17%。\n- **“负载读数”**与实际 CPU 指标需分别判断。\n\n代码和转义原样显示：`**保留星号。 **`、\\*\\*字面星号。 \\*\\*。';
const at='2026-10-18T10:00:00Z';
const snapshot={session:{id:'fixture'},messages:[],actions:[],resources:[],ai:{session:'fixture',status:'completed',cardsOffset:0,turns:1,cards:[{id:'reply',type:'message',content:body,status:'completed',at}]}} as SessionSnapshot;
function Fixture(){const [sre,setSRE]=useState(false);return <main style={{maxWidth:930,margin:'20px auto',padding:'0 24px',height:'calc(100% - 40px)',overflow:'auto'}}><button onClick={()=>setSRE(v=>!v)}>{sre?'查看普通回复':'查看 SRE 报告'}</button>{sre?<SREProse>{body}</SREProse>:<AITranscript snapshot={snapshot}/>}</main>}
createRoot(document.getElementById('root')!).render(<Fixture/>);
