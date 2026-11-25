import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import type {CodexActivityItem,CodexAction} from '../../shared/codex-activity';
import {AssistantMarkdown} from './AssistantMarkdown';
import {Glyph} from './Icons';
import type {LakeAvatarName} from './lakeAvatarCatalog';

type Call=Exclude<CodexActivityItem,{kind:'text'}>;
const verbs:Record<Exclude<CodexAction,'task'>,[string,string,string]>={
  command:['运行','条','命令'],read:['读取','个','文件'],edit:['编辑','个','文件'],integration:['调用','个','工具'],
};
function groupLabel(calls:Call[],live:boolean){
  const counts=new Map<string,number>();
  for(const call of calls){
    if(call.kind==='task')continue;
    const [verb,unit,object]=verbs[call.kind];
    const prefix=call.status==='running'?(live?'正在':'待确认 · '):call.status==='completed'?'已':call.status==='failed'?'失败 · ':call.status==='stopped'?'已停止 · ':'待确认 · ';
    const key=prefix+verb+'|'+unit+object;
    counts.set(key,(counts.get(key)??0)+1);
  }
  return [...counts].map(([key,count])=>{const [action,unit]=key.split('|');return action+' '+count+' '+unit;}).join('，');
}
function Elapsed({start}:{start:string}){
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  return <small>{Math.max(0,Math.floor((now-Date.parse(start))/1000))} 秒</small>;
}
function ToolGroup({calls,live}:{calls:Call[];live:boolean}){
  const current=calls.find(call=>call.status==='running'), active=!!current&&live;
  const [details,setDetails]=useState<'closed'|'live'|'saved'>('closed');
  const open=details!=='closed';
  const bodyId=useId();
  const list=useRef<HTMLUListElement>(null);
  useLayoutEffect(()=>{
    const body=list.current;
    if(!body||details!=='live')return;
    // Keep subsequent streamed rows inside the viewport the reader opened.
    body.style.blockSize=body.getBoundingClientRect().height+'px';
    return ()=>{body.style.removeProperty('block-size');};
  },[details]);
  const icons={command:'terminal',read:'document',edit:'edit',integration:'plug',task:'listTasks'} as const;
  const completed=calls.filter(call=>call.status==='completed').length;
  const finished=completed===calls.length;
  const label=groupLabel(calls,live);
  // Leave a visible blue starting mark before the first result arrives.
  const arc=Math.max(10,100*completed/calls.length);
  return <div className="codex-tool-group">
    <button type="button" title={label} aria-expanded={open} aria-controls={bodyId} className="codex-group-toggle" onClick={()=>setDetails(open?'closed':live?'live':'saved')}>
      <svg className="codex-group-ring" data-complete={finished} viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" strokeWidth="2">
        <circle className="codex-ring-track" cx="8" cy="8" r="6"/>
        <circle cx="8" cy="8" r="6" stroke="currentColor" pathLength="100" strokeDasharray={`${arc} 100`} transform="rotate(-90 8 8)"/>
      </svg>
      <span className="codex-group-label">{label}</span><Glyph name={open?'chevron':'next'} size={12}/>
      {active&&<Elapsed start={current.at}/>}
    </button>
    <ul ref={list} id={bodyId} hidden={!open} aria-label="调用明细" tabIndex={details==='live'?0:undefined} className={details==='live'?'codex-live-details':undefined}>{open&&calls.map(call=>{
      const body=call.text==='内容已隐藏'?'旧记录未保存可展示的正文':call.text;
      const status=call.status==='failed'?'失败':call.status==='stopped'?'已停止':
        call.status==='unknown'||(call.status==='running'&&!live)?'待确认':call.status==='running'?'进行中':'已完成';
      return <li key={call.id} data-kind={call.kind}>
        <Glyph name={icons[call.kind]} size={13}/>
        <div className="codex-call-body">
          {call.kind!=='command'&&body.includes('\n')?<pre className="codex-call-script" tabIndex={0} aria-label="执行记录正文">{body}</pre>:<code>{body}</code>}
          {call.output&&<pre className="codex-call-output">{call.output}</pre>}
        </div>
        <small aria-label={status} className={status==='已完成'?'visually-hidden':undefined}>{status}</small>
      </li>;
    })}</ul>
  </div>;
}
export function CodexActivity({items,live=false,reportText,cursorAvatar}:{items:CodexActivityItem[];live?:boolean;reportText?:string;cursorAvatar?:LakeAvatarName}){
  const groups:(CodexActivityItem|Call[])[]=[];
  let latestProse:CodexActivityItem|undefined;
  for(const item of items){
    if(item.kind==='text'){
      if(!item.text.trim()||item.text.trim()===reportText?.trim())continue;
      groups.push(item);
      latestProse=item;
    }else if(item.kind==='task')groups.push(item);
    else {
      const last=groups.at(-1);
      if(Array.isArray(last))last.push(item);else groups.push([item]);
    }
  }
  // The bounded transcript can evict the first call of a still-visible group.
  // Keep its disclosure mounted while any of that group's calls remain.
  const previousGroups=useRef(new Map<string,string>());
  const keys=new Map<string,string>();
  for(const group of groups){
    if(!Array.isArray(group))continue;
    const first=group[0]!.id;
    const key=group===groups[0]?(previousGroups.current.get(first)??first):first;
    for(const call of group)keys.set(call.id,key);
  }
  useLayoutEffect(()=>{previousGroups.current=keys;});
  if(!groups.length)return null;
  return <div className="codex-activity" aria-label="Codex 执行记录">{groups.map(group=>{
    if(Array.isArray(group)){
      return <ToolGroup key={keys.get(group[0]!.id)} calls={group} live={live}/>;
    }
    if(group.kind==='text')return <AssistantMarkdown key={group.id} cursorAvatar={live&&group===latestProse?cursorAvatar:undefined}>{group.text}</AssistantMarkdown>;
    return <div className="codex-task-event" key={group.id}><Glyph name="listTasks" size={15}/><span>{group.status==='failed'?'任务更新失败':group.status==='running'?'正在更新任务':group.status==='completed'?(group.createdTask?'添加了任务':'更新了任务'):'任务状态待确认'}</span><span className="codex-task-chip">{group.text}</span></div>;
  })}</div>;
}
