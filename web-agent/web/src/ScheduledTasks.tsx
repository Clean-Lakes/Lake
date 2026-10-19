import {ScheduleHistory} from './ScheduleHistory';
import {useEffect,useId,useRef,useState} from 'react';
import type {Project,ScheduledTask} from '../../shared/contracts';
import {api,readableError} from './api';
import {Glyph} from './Icons';
import {scheduleFrequency,scheduleEnabledLabel,scheduleNext,scheduleStatus,scheduleTime} from './scheduledTaskPresentation';
import './scheduledTasks.css';

export function ScheduledTasks({project,onClose,onOpenSession}:{project:Project;onClose:()=>void;onOpenSession:(id:string)=>void|Promise<void>}){
 const [items,setItems]=useState<ScheduledTask[]>([]),[selected,setSelected]=useState(''),[detail,setDetail]=useState<ScheduledTask|null>(null);
 const [loading,setLoading]=useState(true),[detailLoading,setDetailLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[loadError,setLoadError]=useState(''),[revision,setRevision]=useState(0);
 const panel=useRef<HTMLElement>(null),closeButton=useRef<HTMLButtonElement>(null),onCloseRef=useRef(onClose),busyRef=useRef(false);onCloseRef.current=onClose;busyRef.current=busy;
 const title=useId();
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null;closeButton.current?.focus();
  const key=(event:KeyboardEvent)=>{
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onCloseRef.current();return}
   if(event.key!=='Tab')return;
   const nodes=[...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,select,textarea,[tabindex="0"]')??[])].filter(node=>node.getClientRects().length);
   const first=nodes[0],last=nodes.at(-1);if(!first)return;
   if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
  };
  document.addEventListener('keydown',key,true);return()=>{document.removeEventListener('keydown',key,true);previous?.focus()};
 },[]);
 useEffect(()=>{
  const controller=new AbortController();let fetching=false;
  const load=async()=>{if(fetching||busyRef.current)return;fetching=true;try{const result=await api.schedules(project.id,controller.signal);if(controller.signal.aborted)return;setItems(result.items);setSelected(current=>result.items.some(item=>item.id===current)?current:result.items[0]?.id??'');setLoadError('')}catch(cause){if(!controller.signal.aborted)setLoadError(readableError(cause))}finally{fetching=false;if(!controller.signal.aborted)setLoading(false)}};
  void load();const timer=window.setInterval(()=>{if(!document.hidden)void load()},5000);
  return()=>{controller.abort();window.clearInterval(timer)};
 },[project.id,revision]);
 useEffect(()=>{
  const controller=new AbortController();if(!selected){setDetail(null);return}
  setDetailLoading(true);
  api.schedule(project.id,selected,controller.signal).then(value=>{if(!controller.signal.aborted)setDetail(value)}).catch(cause=>{if(!controller.signal.aborted){setDetail(null);setLoadError(readableError(cause))}}).finally(()=>{if(!controller.signal.aborted)setDetailLoading(false)});
  return()=>controller.abort();
 },[project.id,selected,items]);
 async function toggle(task:ScheduledTask){if(busyRef.current)return;setBusy(true);busyRef.current=true;setError('');try{await api.setScheduleEnabled(project.id,task.id,!task.enabled,task.revision);setError('')}catch(cause){setError(readableError(cause))}finally{setBusy(false);busyRef.current=false;setRevision(value=>value+1)}}
 async function open(id:string){try{await onOpenSession(id)}catch(cause){setError(readableError(cause))}}
 const current=items.find(item=>item.id===selected);const task=detail?.id===selected?detail:null;
 return <div className="modal-scrim schedule-scrim" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}><section ref={panel} className="schedule-dialog" role="dialog" aria-modal="true" aria-labelledby={title}>
 <header className="schedule-header"><div><p>{project.name}</p><h2 id={title}>定时任务</h2></div><button ref={closeButton} type="button" className="icon-button" aria-label="关闭定时任务" onClick={onClose}><Glyph name="close" size={16}/></button></header>
 <p className="schedule-description">管理这个项目的巡检与提醒。任务只在 Lake 运行时执行，退出或休眠期间错过的时间不会补跑。</p>
 <div className="schedule-toolbar"><span>{loading?'正在加载…':loadError&&!items.length?'任务暂不可用':`${items.length} 个任务`}</span><button type="button" className="schedule-text-action" disabled={busy||loading} onClick={()=>{setError('');setRevision(value=>value+1)}}><Glyph name="refresh" size={13}/>刷新</button></div>
 {(error||loadError)&&<p role="alert" className="schedule-error schedule-load-error">{error||loadError}</p>}
 {!loading&&!items.length&&!error&&!loadError&&<div className="schedule-empty-state"><Glyph name="clock" size={24}/><h3>还没有定时任务</h3><p>在会话中明确说明巡检目标和执行频率，创建成功后会显示在这里。</p></div>}
 {!!items.length&&<div className="schedule-layout"><nav className="schedule-list" aria-label="定时任务列表">{items.map(item=><button type="button" key={item.id} className={item.id===selected?'is-selected':''} aria-current={item.id===selected?'true':undefined} onClick={()=>setSelected(item.id)}><span><strong>{item.name}</strong><small>{scheduleEnabledLabel(item)}</small></span><p>{scheduleFrequency(item.interval_seconds)} · {item.kind==='workflow'?'只读巡检':'提醒'}</p><p>下次 {scheduleNext(item)}</p><small>{scheduleStatus(item.status)}{item.last_at&&` · ${scheduleTime(item.last_at)}`}</small></button>)}</nav>
 <div className="schedule-detail" aria-busy={detailLoading}>{current&&<><div className="schedule-detail-heading"><h3>{current.name}</h3><button type="button" className="button secondary" disabled={busy} onClick={()=>void toggle(current)}>{busy?'正在保存…':current.enabled?current.status==='running'?'暂停后续':'暂停任务':current.status==='running'?'恢复后续':'恢复任务'}</button></div><dl><div><dt>执行频率</dt><dd>{scheduleFrequency(current.interval_seconds)}</dd></div><div><dt>下次执行</dt><dd>{scheduleNext(current)}</dd></div><div><dt>最近状态</dt><dd>{scheduleStatus(current.status)}{current.last_at&&` · ${scheduleTime(current.last_at)}`}</dd></div></dl>
 {!current.enabled&&<p className="schedule-note">恢复时从下一个执行时间继续；单次任务将在约 1 分钟后执行，不立即补跑。</p>}
 {current.message&&<p className="schedule-message">{current.message}</p>}{current.error&&<p className="schedule-error">{current.error}</p>}
 <button type="button" className="schedule-text-action" onClick={()=>void open(current.session_id)}>打开原会话<Glyph name="next" size={13}/></button>
 {task?<ScheduleHistory task={task} onOpenSession={id=>void open(id)}/>:detailLoading?<p className="schedule-empty">正在读取执行记录…</p>:null}</>}</div></div>}
 <footer className="schedule-footer">时间按本机时区显示。只读巡检需连接模型并开启项目 SRE 协作，提醒不需要。暂停不会中断当前执行。</footer>
 </section></div>;
}
