import type {SpecialistChannelInfo} from '../../shared/contracts';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import type {PilotParticipant} from './superPilotActivity';

export type LakeIslandDrawerProps = {
  title: string;
  projectName?: string;
  statusLabel: string;
  elapsedLabel?: string;
  tone?: string;
  pilot?: boolean;
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

/** Expanded Dynamic Island card matching Lake's unified frosted surface and single-line worker rows. */
export function LakeIslandDrawer({
  title,
  projectName,
  statusLabel,
  elapsedLabel,
  tone = 'neutral',
  pilot = false,
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
  const movingCount = participants.filter(person => person.moving).length;
  const headline = running && participants.length > 0
    ? `${title} · ${movingCount || participants.length} 位专员协作中`
    : waiting
      ? `${title} · ${statusLabel || '等待确认'}`
      : projectName && projectName !== title
        ? `${title} · ${projectName}`
        : title;
  const subtitle = running
    ? (elapsedLabel ? `本次排查已持续 ${elapsedLabel}` : statusLabel || '正在协作处理')
    : waiting
      ? '等待你的操作授权'
      : readyChannels.length > 0
        ? '所有专员已就绪，随时可发起协作'
        : (statusLabel || '当前会话已就绪');

  return <section className="lake-island-drawer" data-tone={tone} aria-label={`${title} 实时协同`}>
    <header className="lake-island-drawer-head">
      <div className="lake-island-drawer-identity">
        <span className="lake-island-drawer-icon" aria-hidden="true">
          <SuperRoleAvatar name={title} pilot={pilot} size={20} motion={running ? 'working' : 'still'}/>
        </span>
        <div className="lake-island-drawer-titles">
          <strong>{headline}</strong>
          <small>{subtitle}</small>
        </div>
      </div>
      {running ? <span className="lake-island-dots" role="img" aria-label="处理中"><i/><i/><i/></span>
        : waiting ? <span className="lake-island-wait-pill"><span className="lake-island-wait-dot" aria-hidden="true"/>需确认</span>
        : <span className="lake-island-idle-pill"><span className="lake-island-idle-dot" aria-hidden="true"/>{readyChannels.length ? `${channels?.length ?? readyChannels.length} 位在线` : statusLabel}</span>}
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
          <SuperRoleAvatar roleId={person.roleId} name={person.name} avatarId={person.avatarId} size={20} motion={person.moving ? 'working' : 'still'}/>
          <strong className="lake-island-participant-name">{person.name}</strong>
          <span className="lake-island-participant-detail">{person.detail || '待命中'}</span>
          <span className="lake-island-participant-state" data-moving={person.moving || undefined}>{person.moving ? '执行中' : '待命'}</span>
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
          <SuperRoleAvatar roleId={channel.roleId} name={channel.roleName} avatarId={channel.avatarId} size={17} motion="still"/>
        </button>)}
      </div>
      <span className="lake-island-ready-copy">{channels?.length ?? readyChannels.length} 位专员就绪</span>
    </div> : <p className="lake-island-empty-note">当前会话已就绪，输入指令即可开始协作。</p>}

    <footer className="lake-island-drawer-actions">
      <button type="button" className="lake-island-collapse-pill" onClick={onClose}>
        收起小岛
      </button>
      <div className="lake-island-footer-right">
        {inspectorAvailable && <button type="button" className="lake-island-secondary-pill" onClick={() => {
          onToggleInspector?.();
          onClose();
        }}>
          {inspectorOpen ? '收起过程' : '查看过程'}
        </button>}
        {stoppable && <button type="button" className="lake-island-stop-btn" disabled={stopping} onClick={() => {
          onStop?.();
          onClose();
        }}>
          {stopping ? '正在停止…' : '停止全部任务'}
        </button>}
      </div>
    </footer>
  </section>;
}
