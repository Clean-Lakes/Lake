import {useEffect,useState} from 'react';
import type {CodexActivityItem} from '../../shared/codex-activity';
import {AssistantMarkdown} from './AssistantMarkdown';
import {Glyph} from './Icons';
import type {LakeAvatarName} from './lakeAvatarCatalog';

type Call=Exclude<CodexActivityItem,{kind:'text'}>;
const icons={command:'terminal',read:'document',edit:'edit',integration:'plug',task:'listTasks'} as const;
const labels={command:'命令',read:'读取文件',edit:'编辑文件',integration:'工具',task:'任务'} as const;

function Elapsed({start}:{start:string}){
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  return <small>{Math.max(0,Math.floor((now-Date.parse(start))/1000))} 秒</small>;
}

function ActivityRow({call,live}:{call:Call;live:boolean}){
  const running=call.status==='running'&&live;
  const status=running?'进行中':call.status==='completed'?'已完成':call.status==='failed'?'失败':call.status==='stopped'?'已停止':'待确认';
  const label=call.kind==='task'&&call.status==='completed'?(call.createdTask?'添加了任务':'更新了任务'):labels[call.kind];
  const body=call.text==='内容已隐藏'?'旧记录未保存可展示的正文':call.text;
  const multiline=body.includes('\n');
  return <div className="codex-event" data-kind={call.kind}>
    <div className="codex-event-heading">
      <Glyph name={icons[call.kind]} size={14}/><span>{label}</span>
      {!multiline&&<code className="codex-event-inline">{body}</code>}
      <span className="codex-event-status" data-status={running?'running':call.status} aria-label={status} title={status}>
        <Glyph name={running?'loader':call.status==='completed'?'check':call.status==='failed'?'alert':call.status==='stopped'?'stop':'clock'} size={12} className={running?'codex-busy':undefined}/>
        {running?<Elapsed start={call.at}/>:call.status!=='completed'&&status}
      </span>
    </div>
    {multiline&&<pre className="codex-event-script" tabIndex={0} aria-label={label+'正文'}>{body}</pre>}
    {call.output&&<pre className="codex-event-output">{call.output}</pre>}
  </div>;
}

export function CodexActivity({items,live=false,reportText,cursorAvatar}:{items:CodexActivityItem[];live?:boolean;reportText?:string;cursorAvatar?:LakeAvatarName}){
  const visible=items.filter(item=>item.kind!=='text'||(item.text.trim()&&item.text.trim()!==reportText?.trim()));
  const latestProse=visible.filter(item=>item.kind==='text').pop();
  if(!visible.length)return null;
  return <div className="codex-activity" aria-label="Codex 执行记录">{visible.map(item=>
    item.kind==='text'?<AssistantMarkdown key={item.id} cursorAvatar={live&&item===latestProse?cursorAvatar:undefined}>{item.text}</AssistantMarkdown>:
      <ActivityRow key={item.id} call={item} live={live}/>
  )}</div>;
}
