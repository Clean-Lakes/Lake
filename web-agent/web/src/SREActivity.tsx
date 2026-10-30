import {Glyph} from './Icons';
import {sessionInspectorId} from './SessionInspectorContext';
import {useEffect,useState} from 'react';
import type {AgentRun,SRETask,SREStepAttempt,SRETranscriptEntry} from '../../shared/contracts';
import {StatusText} from './StatusText';
import {sreIncompleteRead} from './sreOperationPolicy';
import {sreStatus} from './sreTranscript';

export function sreRoleLiveState(task:SRETask,entry:SRETranscriptEntry,run?:AgentRun,attempt?:SREStepAttempt){
 const current=task.runs?.at(-1);
 const owned=!!run&&(!run.sreTaskId||run.sreTaskId===task.id)&&(!attempt||!current||attempt.planRunId===current.id);
 const unknown=attempt?.operations?.some(o=>o.status==='unknown'&&(!task.pilot||o.risk!=='readonly'))??false;
 const liveTask=['active','waiting_approval'].includes(task.status);
 const liveRun=owned&&liveTask&&!!run&&['running','queued','waiting_input','waiting_approval'].includes(run.status)&&(!attempt||['running','queued','waiting_input','waiting_approval'].includes(attempt.status));
 const waiting=liveRun&&(!!run?.pending||run?.status==='waiting_approval');
 const question=liveRun&&!!run?.question;
 const active=entry.kind==='progress'&&owned&&run?.status==='running'&&['active','waiting_approval'].includes(task.status)&&!waiting&&!unknown&&!question&&(!attempt||attempt.status==='running');
 const label=unknown?'结果待核实':waiting?'等待确认':question?(run?.question?.pilot?'等待选择':'等待补充'):task.pilot&&!active&&sreIncompleteRead(attempt?.operations,attempt?.readRecoveries)?'检查未完成':owned&&run?.status!=='running'?(sreStatus[run!.status]??run!.status):!['active','waiting_approval'].includes(task.status)?(sreStatus[task.status]??task.status):active?'执行中':entry.kind==='progress'?'状态待更新':'已结束';
 return {active,label,waiting,unknown};
}
export function sreActivityLabel(run:AgentRun){
 if(run.activityPhase==='waiting_model')return '等待模型响应';
 if(run.activityPhase==='waiting_resource')return '等待资源空闲';
 if(run.activityPhase!=='tool')return '正在分析与思考';
 const name=run.activityTool??'';
 if(['sre_team_update'].includes(name))return '正在与其他专员交流';
 if(['sre_team_read','read_evidence','read_tool_result'].includes(name))return '正在核对已有证据';
 if(['read','ls','glob','grep'].includes(name))return '正在读取文件与日志';
 if(['wait_shell','shell_output','waitShell','getShellOutput'].includes(name))return '正在等待命令输出';
 if(['shell','terminal_execute_command','ssh_terminal_send','terminal_send_input'].includes(name))return '正在执行命令';
 if(name.startsWith('observe_'))return '正在采集现场数据';
 if(['execute_sql','redis_command','list_db_objects','db_table_ddl'].includes(name))return '正在检查数据服务';
 return '正在处理工具调用';
}
export function SREActivity({run,attempt,snapshotClock=false,compact=false,onInspect}:{run:AgentRun;attempt?:SREStepAttempt;snapshotClock?:boolean;compact?:boolean;onInspect?:()=>void}){
 const [now,setNow]=useState(Date.now);
 useEffect(()=>{if(snapshotClock)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[snapshotClock]);
 const activityTime=snapshotClock?Date.parse(run.activityUpdatedAt??run.startedAt??run.createdAt):now;
 const seconds=Math.max(0,Math.floor((activityTime-Date.parse(run.startedAt??run.createdAt))/1000));
 const elapsed=Number.isFinite(seconds)?seconds>=60?`${Math.floor(seconds/60)}分${seconds%60}秒`:`${seconds}秒`:'';
 const evidence=Math.max(run.evidence?.length??0,attempt?.evidence?.length??0);
 if(compact){
  const content=<><Glyph name="waves" size={18}/><StatusText active text={sreActivityLabel(run)}/>{(run.toolCount??0)>0&&<span> · {run.toolCount} 项操作</span>}{evidence>0&&<span> · {evidence} 项证据</span>}{onInspect&&<Glyph name="next" size={11}/>}</>;
  return <div className="reply-duration turn-status is-live sre-conversation-activity" aria-label="专员正在执行">{onInspect?<button type="button" className="turn-duration-disclosure" data-placement="side" aria-controls={sessionInspectorId} title="在右侧查看执行详细过程" onClick={onInspect}>{content}</button>:content}</div>;
 }
 return <div className={`sre-live-activity${snapshotClock?' is-stable':''}`} aria-label="专员正在执行"><span className="sre-activity-orbit" aria-hidden="true"/><span role="status"><StatusText active text={sreActivityLabel(run)}/></span>{elapsed&&<time title={snapshotClock?'最近一次活动时的运行用时':undefined} aria-label={`${snapshotClock?'最近活动时':''}已运行${elapsed}`}>{elapsed}</time>}{(run.toolCount??0)>0&&<span>已调用 {run.toolCount} 次工具</span>}{evidence>0&&<span>已采集 {evidence} 项证据</span>}</div>
}
