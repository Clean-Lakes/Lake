import type {SpecialistChannelInfo} from '../../shared/contracts';
import {Glyph} from './Icons';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import type {PilotParticipant} from './superPilotActivity';

export type LakeIslandDrawerProps = {
  title: string;
  statusLabel: string;
  tone?: string;
  running?: boolean;
  waiting?: boolean;
  participants: readonly PilotParticipant[];
  channels?: readonly SpecialistChannelInfo[];
  inspectorAvailable?: boolean;
  inspectorOpen?: boolean;
  stoppable?: boolean;
  stopping?: boolean;
  onToggleInspector?: () => void;
  onStop?: () => void;
  onOpenSpecialist?: (roleId: string) => void;
  onClose: () => void;
};

/** Expanded drop-down card for the floating Lake Island, revealed after horizontal spring widening. */
export function LakeIslandDrawer({
  title,
  statusLabel,
  tone = 'neutral',
  running = false,
  waiting = false,
  participants,
  channels,
  inspectorAvailable = false,
  inspectorOpen = false,
  stoppable = false,
  stopping = false,
  onToggleInspector,
  onStop,
  onOpenSpecialist,
  onClose,
}: LakeIslandDrawerProps) {
  const readyChannels = channels?.slice(0, 5) ?? [];
  return <section className="lake-island-drawer" data-tone={tone} aria-label={`${title} 实时协同`}>
    <header className="lake-island-drawer-head">
      <div className="lake-island-drawer-status">
        {running ? <span className="lake-island-dots" role="img" aria-label="处理中"><i/><i/><i/></span>
          : waiting ? <span className="lake-island-wait-dot" aria-hidden="true"/>
          : <span className="lake-island-idle-dot" aria-hidden="true"/>}
        <strong>{statusLabel}</strong>
      </div>
      <button type="button" className="lake-island-close" onClick={onClose} aria-label="收起 Lake Island">
        <Glyph name="close" size={14}/>
      </button>
    </header>

    {participants.length > 0 ? <ul className="lake-island-participants" aria-label="协同专员">
      {participants.map(person => <li key={person.key}>
        <button
          type="button"
          className="lake-island-participant-row"
          disabled={!onOpenSpecialist || !person.roleId}
          onClick={() => {
            if (person.roleId && onOpenSpecialist) {
              onOpenSpecialist(person.roleId);
              onClose();
            }
          }}
        >
          <SuperRoleAvatar roleId={person.roleId} name={person.name} avatarId={person.avatarId} size={22} motion={person.moving ? 'working' : 'still'}/>
          <span className="lake-island-participant-copy">
            <strong>{person.name}</strong>
            {person.detail && <small>{person.detail}</small>}
          </span>
          {person.moving && <span className="lake-island-participant-state">执行中</span>}
        </button>
      </li>)}
    </ul> : readyChannels.length > 0 ? <div className="lake-island-ready-strip">
      <div className="lake-island-ready-avatars">
        {readyChannels.map(channel => <button
          key={channel.roleId}
          type="button"
          className="lake-island-ready-chip"
          title={channel.roleName}
          aria-label={`打开 ${channel.roleName}`}
          disabled={!onOpenSpecialist}
          onClick={() => {
            if (onOpenSpecialist) {
              onOpenSpecialist(channel.roleId);
              onClose();
            }
          }}
        >
          <SuperRoleAvatar roleId={channel.roleId} name={channel.roleName} avatarId={channel.avatarId} size={18} motion="still"/>
        </button>)}
      </div>
      <span className="lake-island-ready-copy">{channels?.length ?? readyChannels.length} 位专员就绪</span>
    </div> : <p className="lake-island-empty-note">当前会话已就绪，点击专员或输入指令即可开始协作。</p>}

    {(inspectorAvailable || stoppable) && <footer className="lake-island-drawer-actions">
      {inspectorAvailable && <button type="button" className="button secondary lake-island-action-btn" onClick={() => {
        onToggleInspector?.();
        onClose();
      }}>
        {inspectorOpen ? '收起过程' : '查看过程'}
      </button>}
      {stoppable && <button type="button" className="button lake-island-stop-btn" disabled={stopping} onClick={() => {
        onStop?.();
        onClose();
      }}>
        {stopping ? '正在停止…' : '停止任务'}
      </button>}
    </footer>}
  </section>;
}
