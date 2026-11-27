import {useRef, useState} from 'react';
import type {Project, SpecialistChannelInfo} from '../../shared/contracts';
import {Glyph} from './Icons';
import {SpecialistCreate, SpecialistEdit} from './SpecialistCreate';
import {SpecialistDelete} from './SpecialistDelete';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import {WorkspacePageHeader, WorkspaceSettingSection} from './WorkspacePage';

type SpecialistDialog = {kind: 'create'} | {kind: 'edit' | 'delete'; channel: SpecialistChannelInfo};

export function SpecialistManagement({project, channels, connected, error, onSaved, onDeleted}: {
  project?: Project;
  channels?: readonly SpecialistChannelInfo[];
  connected: boolean;
  error?: string;
  onSaved: (channel: SpecialistChannelInfo) => void;
  onDeleted: (channel: SpecialistChannelInfo) => void;
}) {
  const [dialog, setDialog] = useState<SpecialistDialog>();
  const trigger = useRef<HTMLButtonElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const close = () => setDialog(undefined);

  return <section id="specialists-settings-panel" role="tabpanel" aria-labelledby="specialists-settings-tab" className="workspace-page">
    <WorkspacePageHeader id="specialist-management-title" title="专员管理" actions={project &&
      <button ref={createButton} type="button" className="button primary" aria-label="新建专员" title="新建专员" disabled={!connected}
        onClick={() => setDialog({kind: 'create'})}><Glyph name="plus" size={16}/><span>新建专员</span></button>}/>
    <div className="workspace-page-layout">
      {project ? <WorkspaceSettingSection id="specialist-management-project" title={project.name}
        actions={channels && <span className="settings-note">{channels.length} 位专员</span>}>
        {error && <p className="form-error" role="alert">{error}</p>}
        {channels?.length ? <ul className="workspace-setting-card specialist-management-list">
          {channels.map(channel => {
            const disabled = !connected || channel.roleRevision === undefined;
            return <li key={channel.roleId} className="workspace-setting-row specialist-management-row">
              <div className="specialist-management-profile">
                <SuperRoleAvatar roleId={channel.roleId} name={channel.roleName} avatarId={channel.avatarId} size={28} motion="still"/>
                <div className="workspace-setting-copy">
                  <strong>{channel.roleName}</strong>
                  {channel.duties && <p className="settings-note">{channel.duties}</p>}
                </div>
              </div>
              <div className="specialist-management-actions">
                <button type="button" className="button secondary" aria-label={`编辑专员 ${channel.roleName}`} disabled={disabled}
                  onClick={event => {trigger.current = event.currentTarget; setDialog({kind: 'edit', channel});}}><Glyph name="edit" size={14}/>编辑</button>
                <button type="button" className="icon-button" aria-label={`删除专员 ${channel.roleName}`} title="删除专员" disabled={disabled}
                  onClick={event => {trigger.current = event.currentTarget; setDialog({kind: 'delete', channel});}}><Glyph name="trash" size={15}/></button>
              </div>
            </li>;
          })}
        </ul> : !error && <p className="settings-note" role="status">
          {channels ? '当前项目还没有专员。' : connected ? '正在读取专员…' : '等待重新连接…'}
        </p>}
      </WorkspaceSettingSection> : <p className="settings-note">请先选择项目。</p>}
    </div>
    {dialog?.kind === 'create' && project && <SpecialistCreate projectId={project.id} disabled={!connected}
      returnFocus={createButton} onCreated={onSaved} onClose={close}/>}
    {dialog?.kind === 'edit' && <SpecialistEdit channel={dialog.channel} disabled={!connected}
      returnFocus={trigger} onSaved={onSaved} onClose={close}/>}
    {dialog?.kind === 'delete' && <SpecialistDelete channel={dialog.channel} returnFocus={trigger} onClose={close}
      onDeleted={() => {trigger.current = createButton.current; onDeleted(dialog.channel);}}/>}
  </section>;
}
