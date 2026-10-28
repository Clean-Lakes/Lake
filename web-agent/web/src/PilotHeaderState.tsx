import {useRef,type ReactNode} from 'react';
import type {WorkSession} from '../../shared/contracts';
import type {PilotIslandModel} from './pilotIslandModel';
import {PilotStatusIsland} from './PilotStatusIsland';
import {Glyph} from './Icons';
import {sessionInspectorId} from './SessionInspectorContext';

// Alternatives share one flexible cell. Only the content fades; neither the
// island nor its neighbours follow the length of a status or specialist action.
function HeaderMorphSlot({visible,children,className=''}:{visible:boolean;children:ReactNode;className?:string}){
 return <div className={`header-morph-slot ${className}${visible?' is-visible':''}`} aria-hidden={!visible} inert={!visible}><div className="header-morph-content">{children}</div></div>;
}

type HeaderTerminal={open:boolean;label?:string;kind?:string;connected?:boolean;toggle:()=>void};

export function PilotHeaderState({model,status,normal,onInspect,details,terminal}:{details?:{available:boolean;open:boolean;toggle:()=>void};terminal?:HeaderTerminal;model:PilotIslandModel|null;status?:WorkSession['status'];normal:ReactNode;onInspect:(target:string)=>void}){
 const retained=useRef<PilotIslandModel|null>(model);if(model)retained.current=model;
 const expanded=details?.open===true,showPilot=!!model&&!expanded;
 const compactStatus=model?.tone==='attention'?'waiting_approval':model?.tone==='failed'?'failed':status??'idle';
 const compactLabel=model?.detail.includes('结论不充分')?`${model.label} · 结论不充分`:model?.label;
 return <div className="header-state-area" data-inspector-open={expanded}>
  <div className="header-state-content">
   <HeaderMorphSlot visible={!showPilot} className="header-normal-state">{expanded&&model?<span className={`session-state-badge state-${compactStatus}`} title={model.detail}><span/>{compactLabel}</span>:normal}</HeaderMorphSlot>
   <HeaderMorphSlot visible={showPilot} className="header-pilot-state">{retained.current&&<PilotStatusIsland model={retained.current} status={status} visible={showPilot} showDisclosure={!details?.available} onInspect={onInspect}/>}</HeaderMorphSlot>
  </div>
  <div className="header-panel-controls">
   {details?.available&&<button type="button" className="header-inspector-toggle" aria-label={expanded?'收起计划与执行':'展开计划与执行'} title={expanded?'收起计划与执行':'展开计划与执行'} aria-controls={sessionInspectorId} aria-expanded={expanded} onClick={details.toggle}><Glyph name="document" size={16}/></button>}
   {terminal&&<button id="header-terminal-toggle" type="button" className="header-terminal-toggle" aria-label={terminal.open?'收起资源终端':`展开资源终端${terminal.label?'：'+terminal.label:''}`} title={terminal.open?'收起资源终端':terminal.label??'展开资源终端'} aria-controls="resource-terminal-panel" aria-expanded={terminal.open} onClick={terminal.toggle}>
    <Glyph name={terminal.open?'terminal':terminal.kind==='ssh'?'server':terminal.kind??'terminal'} size={16}/>
    {!terminal.open&&<><span className="header-terminal-label">{terminal.label??'资源终端'}</span>{terminal.connected!==undefined&&<i className="header-terminal-dot" data-connected={terminal.connected} aria-hidden="true"/>}<Glyph name="next" size={12}/></>}
   </button>}
  </div>
 </div>;
}
