import {useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode} from 'react';
import type {Project, Resource} from '../../shared/contracts';
import {readableError} from './api';
import {BulkCheckbox, type BulkSelection} from './BulkNavigationDelete';
import {Glyph} from './Icons';

const projectDate = new Intl.DateTimeFormat('zh-CN', {year: 'numeric', month: 'long', day: 'numeric'});

export function WorkspacePageHeader({id, title, actions}: {
  id: string;
  title: string;
  actions?: ReactNode;
}) {
  return <header className="workspace-page-header">
    <h1 id={id} className="workspace-page-title" title={title}>{title}</h1>
    {actions && <div className="workspace-page-header-actions">{actions}</div>}
  </header>;
}

export function WorkspaceSettingSection({id, title, actions, children}: {
  id: string;
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return <section className="workspace-setting-section" aria-labelledby={id}>
    <div className="workspace-setting-heading">
      <h2 id={id} className="workspace-section-title">{title}</h2>
      {actions && <div className="workspace-setting-actions">{actions}</div>}
    </div>
    {children}
  </section>;
}

function CurrentProject({project, resourceCount, canRename, canDelete, onRename, onDelete}: {
  project: Project;
  resourceCount: number;
  canRename: boolean;
  canDelete: boolean;
  onRename?: (name: string) => Promise<void>;
  onDelete: () => void;
}) {
  const createdAt = new Date(project.createdAt);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setEditing(false);
    setDraft(project.name);
    setSaving(false);
    setError('');
  }, [project.id]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const trimmed = draft.trim();
  const canSubmit = !!trimmed && trimmed !== project.name && canRename && !saving;

  const cancelEdit = () => {
    if (saving) return;
    setEditing(false);
    setDraft(project.name);
    setError('');
    requestAnimationFrame(() => triggerRef.current?.focus({preventScroll: true}));
  };

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!onRename || !canSubmit) return;
    setSaving(true);
    setError('');
    try {
      await onRename(trimmed);
      setEditing(false);
      requestAnimationFrame(() => triggerRef.current?.focus({preventScroll: true}));
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setSaving(false);
    }
  };

  return <section className="workspace-setting-section" aria-label="当前项目">
    <div id="workspace-current-project" className="workspace-setting-card">
      <div className="workspace-setting-row">
        <div className="workspace-setting-copy">
          <div className="workspace-current-project-head">
            <strong aria-live="polite">{project.name}</strong>
            <span className="workspace-current-project-badge">当前项目</span>
          </div>
          <dl className="workspace-project-facts">
            <div><dt>资源</dt><dd>{resourceCount} 项</dd></div>
            {!Number.isNaN(createdAt.getTime()) && <div>
              <dt>创建于</dt><dd><time dateTime={project.createdAt}>{projectDate.format(createdAt)}</time></dd>
            </div>}
          </dl>
        </div>
        <div className="workspace-project-actions">
          {onRename && <button ref={triggerRef} type="button" className="workspace-text-button"
            disabled={!canRename || editing} onClick={() => {setDraft(project.name); setError(''); setEditing(true);}}>
            <Glyph name="edit" size={15}/>重命名
          </button>}
          <button type="button" className="workspace-text-button danger-text" disabled={!canDelete || saving} onClick={onDelete}>
            <Glyph name="trash" size={15}/>删除项目…
          </button>
        </div>
      </div>
      {editing && <form className="workspace-project-rename-form" onSubmit={submitRename}
        onKeyDown={event => {if (event.key === 'Escape') {event.stopPropagation(); cancelEdit();}}}>
        <div className="workspace-project-rename-controls">
          <input ref={inputRef} type="text" aria-label="项目名称" placeholder="输入项目名称" maxLength={120}
            autoFocus disabled={saving} value={draft} onChange={event => {setDraft(event.target.value); setError('');}}/>
          <button type="submit" className="button primary" disabled={!canSubmit}>{saving ? '正在保存…' : '保存'}</button>
          <button type="button" className="button secondary" disabled={saving} onClick={cancelEdit}>取消</button>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
      </form>}
    </div>
  </section>;
}

export function WorkspacePage({projects, project, resources, connected, bulkSelection, bulkSelectedCount,
  onOpenProject, onCreateProject, onRenameProject, onDeleteProject, onToggleBulk,
  onClearSelection, onDeleteSelected}: {
  projects: readonly Project[];
  project?: Project;
  resources: readonly Pick<Resource,'projectId'>[];
  connected: boolean;
  bulkSelection?: BulkSelection;
  bulkSelectedCount: number;
  onOpenProject: (project: Project) => void;
  onCreateProject: () => void;
  onRenameProject?: (project: Project, name: string) => Promise<void>;
  onDeleteProject: (project: Project) => void;
  onToggleBulk: () => void;
  onClearSelection: () => void;
  onDeleteSelected: () => void;
}) {
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState('');
  const needle = query.trim().normalize('NFKC').toLowerCase();
  const visibleProjects = needle
    ? projects.filter(item => item.name.normalize('NFKC').toLowerCase().includes(needle))
    : projects;
  const resourceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const {projectId} of resources) counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
    return counts;
  }, [resources]);
  const handleSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown') {
      const row = list.current?.querySelector<HTMLElement>('button, input:not(:disabled)');
      if (!row) return;
      event.preventDefault();
      row.focus();
    }
    if (event.key === 'Enter' && needle && !bulkSelection && visibleProjects.length === 1) {
      const match = visibleProjects[0];
      if (!match) return;
      event.preventDefault();
      onOpenProject(match);
    }
  };
  return <section id="workspace-page" className="workspace-page workspace-project-page" role="tabpanel" aria-labelledby="workspace-console-tab">
    <WorkspacePageHeader id="workspace-page-title" title="项目"/>
    <div className="workspace-page-layout">
      {project && <CurrentProject project={project} resourceCount={resourceCounts.get(project.id) ?? 0}
        canRename={connected && !bulkSelection} canDelete={connected && !bulkSelection}
        onRename={onRenameProject ? name => onRenameProject(project, name) : undefined}
        onDelete={() => onDeleteProject(project)}/>}
      <WorkspaceSettingSection id="workspace-project-directory-title" title={
        <span className="workspace-section-title-group">
          <span>全部项目</span>
          {!!projects.length && <span className="workspace-directory-count" role="status">
            {needle ? `${visibleProjects.length} / ${projects.length}` : `${projects.length} 个`}
          </span>}
        </span>
      } actions={
        <>
          {!!projects.length && <button type="button" className="workspace-text-button workspace-bulk-toggle" aria-pressed={!!bulkSelection}
            aria-label={bulkSelection ? '完成' : '批量管理'} title={bulkSelection ? '完成' : '批量管理'}
            disabled={!connected && !bulkSelection} onClick={onToggleBulk}>
            <Glyph name={bulkSelection ? 'check' : 'listTasks'} size={16}/><span>{bulkSelection ? '完成' : '批量管理'}</span>
          </button>}
          <button type="button" className="button workspace-soft-primary" aria-label="新建项目" title="新建项目" disabled={!connected} onClick={onCreateProject}>
            <Glyph name="plus" size={15}/><span>新建项目</span>
          </button>
        </>
      }>
        {!!projects.length && <div className="workspace-project-toolbar">
          <div className="workspace-project-search">
            <Glyph name="search" size={16}/>
            <input ref={search} type="search" aria-label="搜索项目" placeholder="搜索项目" value={query}
              aria-keyshortcuts={bulkSelection ? 'ArrowDown' : 'ArrowDown Enter'}
              onChange={event => setQuery(event.target.value)} onKeyDown={handleSearchKey}/>
            {query && <button type="button" className="icon-button" aria-label="清除项目搜索"
              onClick={() => {setQuery(''); search.current?.focus();}}><Glyph name="close" size={14}/></button>}
          </div>
        </div>}
        {bulkSelection && <div className="workspace-bulk-actions" aria-label="项目批量管理">
          <span role="status">已选 {bulkSelectedCount} 项</span>
          <button type="button" className="workspace-text-button" disabled={!bulkSelectedCount || !connected}
            onClick={onClearSelection}>清空</button>
          <button type="button" className="workspace-text-button danger-text" disabled={!bulkSelectedCount || !connected}
            onClick={onDeleteSelected}>删除所选…</button>
        </div>}
        <div className="workspace-project-sheet workspace-setting-card">
          {visibleProjects.length ? <>
            <ul ref={list} className="workspace-projects-list" aria-label="项目列表">{visibleProjects.map(item => {
              const current = item.id === project?.id || undefined;
              const row = <>
                <span className="workspace-project-row-icon"><Glyph name="folder" size={17}/></span>
                <span className="workspace-project-name">{item.name}</span>
                <span className="workspace-project-resource-count">
                  {resourceCounts.get(item.id) ?? 0}<span> 项资源</span>
                </span>
                <span className="workspace-project-indicator" aria-hidden="true">
                  {current ? <Glyph name="check" size={14}/> : !bulkSelection && <Glyph name="next" size={15}/>}
                </span>
              </>;
              return <li className="workspace-project-list-item" key={item.id}>
                {bulkSelection
                  ? <label className="workspace-project-row workspace-project-select" aria-current={current} title={item.name}>
                    <BulkCheckbox target={{kind: 'project', id: item.id, projectId: item.id, name: item.name}} selection={bulkSelection}/>
                    {row}
                  </label>
                  : <button type="button" className="workspace-project-row" aria-current={current}
                    title={item.name} onClick={() => onOpenProject(item)}>
                    <span className="visually-hidden">{current ? '打开当前项目 ' : '切换到 '}</span>
                    {row}
                  </button>}
              </li>;
            })}</ul>
          </> : <div className="workspace-projects-empty">
            <Glyph name={needle ? 'search' : 'lakeFolder'} size={24}/>
            <p>{needle ? '没有匹配的项目' : '暂无项目'}</p>
          </div>}
        </div>
      </WorkspaceSettingSection>
    </div>
  </section>;
}
