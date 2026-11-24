import {useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode} from 'react';
import type {Project, Resource} from '../../shared/contracts';
import {BulkCheckbox, type BulkSelection} from './BulkNavigationDelete';
import {Glyph} from './Icons';

const projectDate = new Intl.DateTimeFormat('zh-CN', {year: 'numeric', month: 'long', day: 'numeric'});

export function WorkspacePageHeader({id, title, metadata, description, actions, onOpenNavigation, onBack}: {
  id: string;
  title: ReactNode;
  metadata?: ReactNode;
  description?: string;
  actions?: ReactNode;
  onOpenNavigation: () => void;
  onBack?: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => heading.current?.focus({preventScroll: true}), [id]);
  return <header className="workspace-header workspace-page-header">
    <div className="workspace-page-title-row">
      <button type="button" className="icon-button mobile-only" aria-label="打开项目导航" onClick={onOpenNavigation}>
        <Glyph name="menu" size={21}/>
      </button>
      <div className="workspace-page-heading">
        <div className="workspace-page-heading-line">
          <h1 id={id} ref={heading} tabIndex={-1}>{title}</h1>
          {metadata}
        </div>
        {description && <p>{description}</p>}
      </div>
      <div className="workspace-page-header-actions">
        {onBack && <button type="button" className="icon-button mobile-only" aria-label="返回上一页" onClick={onBack}><Glyph name="previous" size={17}/></button>}
        {actions}
      </div>
    </div>
  </header>;
}

function CurrentProject({project, resourceCount, canDelete, onDelete}: {
  project: Project;
  resourceCount: number;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const createdAt = new Date(project.createdAt);
  return <section id="workspace-current-project" className="workspace-current-project" aria-labelledby="workspace-current-project-title">
    <div className="workspace-current-project-label">当前项目</div>
    <h2 id="workspace-current-project-title" aria-live="polite">{project.name}</h2>
    <dl className="workspace-project-facts">
      <div><dt>资源</dt><dd>{resourceCount} 项</dd></div>
      {!Number.isNaN(createdAt.getTime()) && <div>
        <dt>创建于</dt><dd><time dateTime={project.createdAt}>{projectDate.format(createdAt)}</time></dd>
      </div>}
    </dl>
    <div className="workspace-current-project-actions">
      <button type="button" className="workspace-text-button danger-text" disabled={!canDelete} onClick={onDelete}>
        <Glyph name="trash" size={15}/>删除项目…
      </button>
    </div>
  </section>;
}

export function WorkspacePage({projects, project, resources, connected, bulkSelection, bulkSelectedCount,
  onOpenNavigation, onOpenProject, onCreateProject, onDeleteProject, onToggleBulk,
  onClearSelection, onDeleteSelected}: {
  projects: readonly Project[];
  project?: Project;
  resources: readonly Pick<Resource,'projectId'>[];
  connected: boolean;
  bulkSelection?: BulkSelection;
  bulkSelectedCount: number;
  onOpenNavigation: () => void;
  onOpenProject: (project: Project) => void;
  onCreateProject: () => void;
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
  return <section id="workspace-page" className="workspace-page workspace-project-page" aria-labelledby="workspace-page-title">
    <WorkspacePageHeader id="workspace-page-title" title="切换项目" onOpenNavigation={onOpenNavigation} metadata={
      <span className="workspace-directory-count" role="status">
        {needle ? `${visibleProjects.length} / ${projects.length}` : projects.length} 项
      </span>
    } actions={<>
      {!!projects.length && <>
        <div className="workspace-project-search">
          <Glyph name="search" size={16}/>
          <input ref={search} type="search" aria-label="搜索项目" placeholder="搜索项目" value={query}
            aria-keyshortcuts={bulkSelection ? 'ArrowDown' : 'ArrowDown Enter'}
            onChange={event => setQuery(event.target.value)} onKeyDown={handleSearchKey}/>
          {query && <button type="button" className="icon-button" aria-label="清除项目搜索"
            onClick={() => {setQuery(''); search.current?.focus();}}><Glyph name="close" size={14}/></button>}
        </div>
        <button type="button" className="workspace-text-button workspace-bulk-toggle" aria-pressed={!!bulkSelection}
          disabled={!connected && !bulkSelection} onClick={onToggleBulk}>
          <Glyph name={bulkSelection ? 'check' : 'listTasks'} size={16}/>{bulkSelection ? '完成' : '批量管理'}
        </button>
      </>}
      <button type="button" className="button primary" disabled={!connected} onClick={onCreateProject}>
        <Glyph name="plus" size={16}/>新建项目
      </button>
    </>}/>
    <div className="workspace-page-layout">
      <div className="workspace-project-directory">
        {bulkSelection && <div className="workspace-bulk-actions" aria-label="项目批量管理">
          <span role="status">已选 {bulkSelectedCount} 项</span>
          <button type="button" className="workspace-text-button" disabled={!bulkSelectedCount || !connected}
            onClick={onClearSelection}>清空</button>
          <button type="button" className="workspace-text-button danger-text" disabled={!bulkSelectedCount || !connected}
            onClick={onDeleteSelected}>删除所选…</button>
        </div>}
        <div className={`workspace-project-sheet${bulkSelection ? ' is-bulk-selecting' : ''}`}>
          {visibleProjects.length ? <>
            <div className="workspace-project-sheet-heading" aria-hidden="true"><span>项目名称</span><span>资源</span></div>
            <ul ref={list} className="workspace-projects-list" aria-label="项目列表">{visibleProjects.map(item => {
              const current = item.id === project?.id || undefined;
              const row = <>
                <span className="workspace-project-row-icon"><Glyph name="folder" size={17}/></span>
                <span className="workspace-project-name">{item.name}</span>
                <span className="workspace-project-resource-count">
                  {resourceCounts.get(item.id) ?? 0}<span className="visually-hidden"> 项资源</span>
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
      </div>
      {project && <CurrentProject project={project} resourceCount={resourceCounts.get(project.id) ?? 0}
        canDelete={connected && !bulkSelection} onDelete={() => onDeleteProject(project)}/>}
    </div>
  </section>;
}
