// Replay the two completion snapshots through the same transcript as Lake Dev.
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {AITranscript} from '../../src/AIPanel';
import type {AICard, Message, Resource, SessionSnapshot} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/theme.css';
import '../../src/assistantProse.css';
import '../../src/conversationBubbles.css';

document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') ?? 'dark';
const root = createRoot(document.getElementById('root')!);
const result = document.getElementById('result')!;
const sessionId = 'fixture';
const data = {root_turn_id: 'turn', source_message_id: 'request'};
const started = Date.now() - 32000;
const at = (offset: number) => new Date(started + offset).toISOString();
const prefix = '已将样例专员的头像换成';
const conclusion = prefix + '浣熊 🦝。';
const longConclusion = conclusion + '这是本地样例结果，后续打开时会继续显示新的头像。'.repeat(3);
const history: Message = {id:'history',sessionId,role:'assistant',text:'较早的对话正文。\n\n'.repeat(20),createdAt:at(-3000)};
const request: Message = {id:'request',sessionId,role:'user',text:'换一个样例专员头像',createdAt:at(0)};
const operation: AICard = {id:'operation',type:'operation',title:'manage_specialist',status:'completed',at:at(100),data};
const resource = {id:'sample',name:'样例资源',projectId:'project',kind:'local'} as Resource;
type Phase = 'running'|'persisted'|'completed'|'cancelled'|'failed';

function render(phase: Phase, text = '', resources: Resource[] = []) {
  const persisted = phase === 'persisted';
  const status = persisted ? 'running' : phase;
  const ended = status !== 'running';
  const cards: AICard[] = [operation];
  if (text) cards.push({id:'summary',type:'message',content:text,status,at:at(12000),data});
  const messages = [history,request];
  if (persisted || phase === 'completed') messages.push({id:'saved',sessionId,role:'assistant',text,createdAt:at(33000),replyToMessageId:request.id});
  const snapshot = {
    session:{id:sessionId,projectId:'project',workspaceRole:'router',title:'Pilot',tags:[]}, messages, resources, actions:[],
    ai:{session:sessionId,cards,cardsOffset:0,rootTurnId:'turn',sourceMessageIds:[request.id],status:persisted?'completed':status,replyStatus:status},
    replyTimings:[{messageId:request.id,startedAt:at(0),finishedAt:ended?at(33000):'',status}],
  } as SessionSnapshot;
  flushSync(() => root.render(<div className="conversation" style={{height:'70vh',maxWidth:820,margin:'auto'}}>
    <AITranscript snapshot={snapshot} assistantIdentity={{name:'Pilot',pilot:true}}/>
  </div>));
}

const viewport = () => document.querySelector<HTMLElement>('.conversation')!;
const paragraph = () => document.querySelector('[data-conversation-entry="summary"] .assistant-prose p');
const footer = () => paragraph()?.closest('.ai-turn')?.querySelector<HTMLButtonElement>('.reply-footer button');
const check = (condition: unknown, message: string) => {if (!condition) throw Error(message);};
const frame = () => new Promise<void>(done => requestAnimationFrame(() => done()));
async function waitForText(text: string) {
  const end = performance.now() + 2000;
  while (paragraph()?.textContent !== text) {
    check(performance.now() < end, '正文未完整显示');
    await frame();
  }
}
async function start() {
  render('running');
  render('running',prefix);
  await waitForText(prefix);
}

async function verify() {
  await start();
  render('running',conclusion);
  await waitForText(conclusion);
  viewport().scrollTop = viewport().scrollHeight;
  const line = paragraph()!, text = line.firstChild!, link = footer()!;
  const y = line.getBoundingClientRect().top, top = viewport().scrollTop;
  link.focus({preventScroll:true});
  getSelection()?.setBaseAndExtent(text,0,text,3);
  render('persisted',conclusion);
  render('completed',conclusion,[resource]);
  check(paragraph() === line && line.firstChild === text && getSelection()?.toString() === prefix.slice(0,3), '完成时替换了已显示的正文');
  check(footer() === link && document.activeElement === link, '完成时替换了执行过程入口');
  check(line.getBoundingClientRect().top === y && viewport().scrollTop === top, '完成时会话滚动位置发生变化');

  await start();
  viewport().scrollTop = 20;
  render('running',longConclusion);
  render('completed',longConclusion);
  if (!document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    check(paragraph()?.textContent === prefix, '成功结束立即刷出了整个缓冲尾部');
  }
  await waitForText(longConclusion);
  check(viewport().scrollTop === 20, '尾部补齐打断了历史阅读');

  for (const phase of ['cancelled','failed'] as const) {
    await start();
    render('running',longConclusion);
    render(phase,longConclusion);
    check(paragraph()?.textContent === longConclusion, '停止或失败延迟了实际正文');
  }
}

void verify().then(() => {result.value = '通过';}, error => {result.value = String(error);});
