import type {SessionSnapshot,WorkSession} from '../../shared/contracts';
import {sessionBadgeState} from './sessionBadgeState';
import {sreSessionPresentation} from './sreSessionPresentation';
import {pilotIslandModel} from './pilotIslandModel';

export function SessionStatusDot({session,snapshot}:{session:WorkSession;snapshot?:SessionSnapshot|null}) {
 // A background catalog update must win over an older cached task or turn.
 const current=snapshot?.session.id===session.id&&snapshot.session.updatedAt===session.updatedAt&&snapshot.session.status===session.status?snapshot:undefined;
 const presentation=sreSessionPresentation(session,current?.sre?.tasks,current?.ai?.turnStartedAt);
 const badge=sessionBadgeState(presentation.status??session.status,presentation.label);
 const pilot=pilotIslandModel(current);
 const tone=pilot?.tone??badge.tone;
 if(tone==='success')return null;
 const label=pilot?`Lake Pilot：${pilot.detail}`:badge.label;
 return <span className="session-status-dot" data-tone={tone} data-pilot={pilot?'true':undefined} title={label} role="img" aria-label={`会话状态：${label}`}/>;
}
