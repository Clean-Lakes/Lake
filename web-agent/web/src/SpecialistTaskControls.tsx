import type {SessionSnapshot} from '../../shared/contracts';
import {api} from './api';
import {AIPending} from './AIPanel';
import {AgentQuestion} from './AgentQuestion';
import {HostKeyTrust} from './HostKeyTrust';

/** A role page is display-only; every decision uses its original task session. */
export function SpecialistTaskControls({snapshot,connected}:{snapshot:SessionSnapshot;connected:boolean}){
 const session=snapshot.session.id,view=snapshot.ai;
 const refresh=()=>api.snapshot(session);
 return <fieldset className="specialist-task-controls" disabled={!connected} aria-label={`任务确认：${snapshot.superagent?.task.title??snapshot.session.title}`}>
  {view?.question&&<AgentQuestion session={session} request={view.question} refresh={refresh}/>}
  {view?.pending&&<AIPending session={session} view={view} attachments={snapshot.messages.flatMap(message=>message.files??[])} refresh={refresh}/>}
  {snapshot.hostKeyTrust&&<HostKeyTrust session={session} prompt={snapshot.hostKeyTrust} disabled={!connected} refresh={refresh}/>}
 </fieldset>;
}
