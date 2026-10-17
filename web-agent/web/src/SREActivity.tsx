import {useEffect,useState} from 'react';
import type {AgentRun,SRETask,SREStepAttempt,SRETranscriptEntry} from '../../shared/contracts';
import {StatusText} from './StatusText';
import {sreStatus} from './sreTranscript';

export function sreRoleLiveState(task:SRETask,entry:SRETranscriptEntry,run?:AgentRun,attempt?:SREStepAttempt){
 const current=task.runs?.at(-1);
 const owned=!!run&&(!run.sreTaskId||run.sreTaskId===task.id)&&(!attempt||!current||attempt.planRunId===current.id);
 const unknown=attempt?.operations?.some(o=>o.status==='unknown')??false;
 const waiting=owned&&(!!run?.pending||run?.status==='waiting_approval');
 const active=entry.kind==='progress'&&owned&&run?.status==='running'&&['active','waiting_approval'].includes(task.status)&&!waiting&&!unknown&&(!attempt||attempt.status==='running');
 const label=unknown?'结果待核实':waiting?'等待确认':owned&&run?.status!=='running'?(sreStatus[run!.status]??run!.status):!['active','waiting_approval'].includes(task.status)?(sreStatus[task.status]??task.status):active?'执行中':entry.kind==='progress'?'状态待更新':'已结束';
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
export function SREActivity({run,attempt}:{run:AgentRun;attempt?:SREStepAttempt}){
 const [now,setNow]=useState(Date.now);
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[]);
 const seconds=Math.max(0,Math.floor((now-Date.parse(run.startedAt??run.createdAt))/1000));
 const elapsed=Number.isFinite(seconds)?seconds>=60?`${Math.floor(seconds/60)}分${seconds%60}秒`:`${seconds}秒`:'';
 const evidence=Math.max(run.evidence?.length??0,attempt?.evidence?.length??0);
 return <div className="sre-live-activity" aria-label="专员正在执行"><span className="sre-activity-orbit" aria-hidden="true"/><span role="status"><StatusText active text={sreActivityLabel(run)}/></span>{elapsed&&<time aria-label={`已运行${elapsed}`}>{elapsed}</time>}{(run.toolCount??0)>0&&<span>已调用 {run.toolCount} 次工具</span>}{evidence>0&&<span>已采集 {evidence} 项证据</span>}</div>
}
