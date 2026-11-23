import {useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {Project, Resource} from '../../shared/contracts';
import {BulkCheckbox, type BulkSelection} from './BulkNavigationDelete';
import {Glyph} from './Icons';

export function WorkspaceSidebar({modelConfigured, unreadUpdate, connected, onProjects, onSettings, onUpdates, onTrash}: {
  modelConfigured: boolean;
  unreadUpdate: boolean;
  connected: boolean;
  onProjects: () => void;
  onSettings: () => void;
  onUpdates: () => void;
  onTrash: () => void;
}) {
  return <nav className="workspace-sidebar-links" aria-label="工作区导航">
    <button type="button" aria-current="page" aria-controls="workspace-page" onClick={onProjects}>
      <Glyph name="folder" size={17}/><span>项目</span>
    </button>
    <div className="workspace-sidebar-utilities">
      <button type="button" onClick={onSettings}>
        <Glyph name="settings" size={17}/><span>设置</span>{!modelConfigured && <small>待配置</small>}
      </button>
      <button type="button" onClick={onUpdates}>
        <Glyph name="refresh" size={17}/><span>检查更新</span>{unreadUpdate && <small>新版本</small>}
      </button>
      <button type="button" disabled={!connected} onClick={onTrash}>
        <Glyph name="trash" size={17}/><span>已删除</span>
      </button>
    </div>
  </nav>;
}

const projectDate = new Intl.DateTimeFormat('zh-CN', {year: 'numeric', month: 'long', day: 'numeric'});

function CurrentProject({project, resourceCount, connected, onOpen, onDelete}: {
  project: Project;
  resourceCount: number;
  connected: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const createdAt = new Date(project.createdAt);
  return <section id="workspace-current-project" className="workspace-current-project" aria-labelledby="workspace-current-project-title">
    <div className="workspace-current-project-label"><Glyph name="lakeFolder" size={20}/>当前项目</div>
    <h2 id="workspace-current-project-title" aria-live="polite">{project.name}</h2>
    <dl className="workspace-project-facts">
      <div><dt>资源</dt><dd>{resourceCount} 项</dd></div>
      {!Number.isNaN(createdAt.getTime()) && <div>
        <dt>创建于</dt><dd><time dateTime={project.createdAt}>{projectDate.format(createdAt)}</time></dd>
      </div>}
    </dl>
    <div className="workspace-current-project-actions">
      <button type="button" className="button secondary workspace-enter-project" onClick={onOpen}>
        进入项目<Glyph name="arrow" size={16}/>
      </button>
      <button type="button" className="workspace-text-button danger-text" disabled={!connected} onClick={onDelete}>
        <Glyph name="trash" size={15}/>删除项目…
      </button>
    </div>
  </section>;
}

export function WorkspacePage({projects, project, resources, connected, bulkSelection, bulkSelectedCount,
  onOpenNavigation, onOpenProject, onSelectProject, onCreateProject, onDeleteProject, onToggleBulk,
  onClearSelection, onDeleteSelected}: {
  projects: readonly Project[];
  project?: Project;
  resources: readonly Pick<Resource,'projectId'>[];
  connected: boolean;
  bulkSelection?: BulkSelection;
  bulkSelectedCount: number;
  onOpenNavigation: () => void;
  onOpenProject: () => void;
  onSelectProject: (project: Project) => void;
  onCreateProject: () => void;
  onDeleteProject: (project: Project) => void;
  onToggleBulk: () => void;
  onClearSelection: () => void;
  onDeleteSelected: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const search = useRef<HTMLInputElement>(null);
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
  useLayoutEffect(() => heading.current?.focus({preventScroll: true}), []);

  return <div id="workspace-page" className="workspace-page" aria-labelledby="workspace-page-title">
    <header className="workspace-header workspace-page-header">
      <div className="workspace-page-frame workspace-page-title-row">
        <button type="button" className="icon-button mobile-only" aria-label="打开项目导航" onClick={onOpenNavigation}>
          <Glyph name="menu" size={21}/>
        </button>
        <h1 id="workspace-page-title" ref={heading} tabIndex={-1}>工作区</h1>
        <button type="button" className="button primary" disabled={!connected} onClick={onCreateProject}>
          <Glyph name="plus" size={16}/>新建项目
        </button>
      </div>
    </header>
    <div className="workspace-page-scroll">
      <div className="workspace-page-frame workspace-page-layout">
        {project && <CurrentProject project={project} resourceCount={resourceCounts.get(project.id) ?? 0}
          connected={connected && !bulkSelection} onOpen={onOpenProject} onDelete={() => onDeleteProject(project)}/>}
        <section className="workspace-project-directory" aria-labelledby="workspace-projects-title">
          <div className="workspace-directory-heading">
            <h2 id="workspace-projects-title" tabIndex={-1}>项目</h2>
            <span className="workspace-directory-count" role="status">
              {needle ? `${visibleProjects.length} / ${projects.length}` : projects.length} 项
            </span>
            {!!projects.length && <button type="button" className="workspace-text-button" aria-pressed={!!bulkSelection}
              disabled={!connected && !bulkSelection} onClick={onToggleBulk}>
              <Glyph name={bulkSelection ? 'check' : 'listTasks'} size={16}/>{bulkSelection ? '完成' : '批量管理'}
            </button>}
          </div>
          {!!projects.length && <div className="workspace-project-search">
            <Glyph name="search" size={16}/>
            <input ref={search} type="search" aria-label="搜索项目" placeholder="搜索项目" value={query}
              onChange={event => setQuery(event.target.value)}/>
            {query && <button type="button" className="icon-button" aria-label="清除项目搜索"
              onClick={() => {setQuery(''); search.current?.focus();}}><Glyph name="close" size={14}/></button>}
          </div>}
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
              <ul className="workspace-projects-list" aria-label="项目列表">{visibleProjects.map(item => {
                const current = item.id === project?.id;
                return <li className="workspace-project-list-item" key={item.id}>
                  {bulkSelection && <label className="workspace-project-select">
                    <BulkCheckbox target={{kind: 'project', id: item.id, projectId: item.id, name: item.name}} selection={bulkSelection}/>
                  </label>}
                  <button type="button" className="workspace-project-row" aria-current={current ? 'true' : undefined}
                    title={item.name} onClick={() => onSelectProject(item)}>
                    <span className="workspace-project-row-icon"><Glyph name="folder" size={17}/></span>
                    <span className="workspace-project-name">{item.name}</span>
                    <span className="workspace-project-resource-count">
                      {resourceCounts.get(item.id) ?? 0}<span className="visually-hidden"> 项资源</span>
                    </span>
                    <span className="workspace-project-selected" aria-hidden="true">
                      {current && <Glyph name="check" size={14}/>}
                    </span>
                  </button>
                </li>;
              })}</ul>
            </> : <div className="workspace-projects-empty">
              <Glyph name={needle ? 'search' : 'lakeFolder'} size={24}/>
              <p>{needle ? '没有匹配的项目' : '暂无项目'}</p>
            </div>}
          </div>
        </section>
      </div>
    </div>
  </div>;
}
