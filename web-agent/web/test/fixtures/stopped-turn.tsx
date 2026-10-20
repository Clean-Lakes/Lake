// Synthetic stopped turn: no model, backend, host or permission calls.
import {createRoot} from 'react-dom/client';
import {AITranscript} from '../../src/AIPanel';
import type {SessionSnapshot} from '../../../shared/contracts';
import '../../src/theme.css';
import '../../src/styles.css';
import '../../src/assistantProse.css';
import '../../src/conversationDirectory.css';
document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')||'light';
const snapshot={
 session:{id:'stopped-fixture'},resources:[],actions:[],
 messages:[{id:'question',role:'user',text:'检查演示服务状态',createdAt:'2026-10-20T00:00:00Z'}],
 replyTimings:[{messageId:'question',startedAt:'2026-10-20T00:00:00Z',finishedAt:'2026-10-20T00:00:04Z',status:'cancelled'}],
 ai:{session:'stopped-fixture',status:'cancelled',cardsOffset:0,cards:[{id:'stop',type:'error',status:'cancelled',content:'context canceled',at:'2026-10-20T00:00:04Z'}]},
} as SessionSnapshot;
createRoot(document.getElementById('root')!).render(<main style={{maxWidth:860,margin:'48px auto',padding:24}}><AITranscript snapshot={snapshot}/></main>);
