import {useState} from 'react';
import {Glyph} from './Icons';
import {pilotWorkForEntry} from './pilotPresentation';
import {sreStatus} from './sreTranscript';

export function PilotAgentWork({work}:{work:ReturnType<typeof pilotWorkForEntry>}){
 const [inspected,setInspected]=useState('');
 if(!work)return null;
 const selected=work.steps.find(value=>value.step.id===inspected);
 return <div className="pilot-agent-work">
  <nav className="pilot-step-navigation" aria-label="当前专员的工作步骤"><ol>{work.steps.map(({step,status},index)=><li key={step.id}>
   {index>0&&<span className="pilot-step-separator" aria-hidden="true">/</span>}
   <button type="button" aria-current={['running','waiting_input','waiting_approval','unknown','failed'].includes(status)?'step':undefined} aria-expanded={inspected===step.id} aria-label={`步骤 ${index+1}：${step.description}，${sreStatus[status]??status}`} title={step.description} onClick={()=>setInspected(current=>current===step.id?'':step.id)}>
    {status==='succeeded'&&<Glyph name="check" size={12}/>}<span>{step.description}</span>
   </button>
  </li>)}</ol><span className="pilot-work-progress" aria-label={`本工作项已完成 ${work.completed} / ${work.steps.length} 步骤`}>{work.completed} / {work.steps.length}</span></nav>
  {selected&&<div className="pilot-step-inspection"><p>{selected.step.description} · {sreStatus[selected.status]??selected.status}</p>{selected.step.completionChecks.length>0&&<ul>{selected.step.completionChecks.map((condition,index)=><li key={index}>{condition}</li>)}</ul>}</div>}
 </div>;
}
