import {useEffect, useId, useState, type CSSProperties} from 'react';
import {Glyph, type GlyphName} from './Icons';
import {WorkspacePageHeader} from './WorkspacePage';
import {navigateSettingsTabs} from './settingsFocus';
import {consoleCategories, consolePanelId, consoleTabId, type ConsolePage} from './workspaceConsoleTabs';
import './settingsOverview.css';

const compactLayout = '(max-width: 620px)';
const groups = [
  {
    id: 'general', label: '常规', icon: 'settings', heading: '工作区与偏好',
    destinations: [
      {page: 'workspace', note: '切换或管理项目'},
      {page: 'appearance', note: '选择浅色、深色或跟随系统'},
      {page: 'conversation', note: '发送快捷键和文字补齐'},
    ],
  },
  {
    id: 'pilot', label: 'Pilot', icon: 'lakePilot', heading: 'Pilot 配置',
    destinations: [
      {page: 'models', note: '管理供应商和默认模型'},
      {page: 'agents', note: '配置 Codex 执行器'},
      {page: 'channels', note: '管理外部客户端连接'},
    ],
  },
  {
    id: 'app', label: '应用', icon: 'layers', heading: '扩展与更新',
    destinations: [
      {page: 'mcp', note: '管理 MCP 服务'},
      {page: 'skills', note: '管理本机技能'},
      {page: 'updates', note: '查看版本和可用更新'},
    ],
  },
] as const satisfies readonly {
  id: string;
  label: string;
  icon: GlyphName;
  heading: string;
  destinations: readonly {page: ConsolePage; note: string}[];
}[];

export function SettingsOverview({typescriptBackend, onPage}: {
  typescriptBackend: boolean;
  onPage: (page: ConsolePage) => void;
}) {
  const id = useId();
  const [selection, setSelection] = useState({active: 0, outgoing: -1});
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia(compactLayout).matches);
  const available = new Map(consoleCategories(typescriptBackend, '').flatMap(group => group.items.map(item => [item.key, item])));

  useEffect(() => {
    const media = window.matchMedia(compactLayout);
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  function select(index: number) {
    setSelection(current => current.active === index ? current : {active: index, outgoing: current.active});
  }

  return <section className="workspace-page" aria-labelledby="settings-overview-title">
    <WorkspacePageHeader id="settings-overview-title" title="设置概览"/>
    <div className="workspace-page-layout" id={consolePanelId('overview')} role="tabpanel" aria-labelledby={consoleTabId('overview')}>
      <section className="settings-bento-card workspace-setting-card" aria-labelledby={id + '-title'} data-compact={compact || undefined}>
        <header className="settings-bento-header">
          <span className="settings-bento-mark"><Glyph name="settings" size={18}/></span>
          <h2 id={id + '-title'}>常用设置</h2>
        </header>
        <div className="settings-bento-stage">
          <div className="settings-bento-window">
            <div className="settings-bento-tabs" role="tablist" aria-label="常用设置分组"
              aria-orientation={compact ? 'horizontal' : 'vertical'}
              style={{'--settings-bento-index': selection.active, '--settings-bento-count': groups.length} as CSSProperties}
              onKeyDown={event => navigateSettingsTabs(event, event.currentTarget)}>
              <span className="settings-bento-indicator" aria-hidden="true"/>
              {groups.map((group, index) => <button type="button" key={group.id} role="tab" className="settings-bento-tab"
                id={id + '-tab-' + group.id} aria-controls={id + '-panel-' + group.id}
                aria-selected={selection.active === index} tabIndex={selection.active === index ? 0 : -1}
                onClick={() => select(index)}>
                <Glyph name={group.icon} size={16}/><span>{group.label}</span>
              </button>)}
            </div>
            <div className="settings-bento-panels" data-transitioned={selection.outgoing >= 0 || undefined}>
              {groups.map((group, index) => {
                const active = selection.active === index;
                return <section key={group.id} className="settings-bento-panel" role="tabpanel"
                  id={id + '-panel-' + group.id} aria-labelledby={id + '-tab-' + group.id}
                  aria-hidden={!active || undefined} inert={!active}
                  data-state={active ? 'active' : selection.outgoing === index ? 'outgoing' : undefined}>
                  <h3>{group.heading}</h3>
                  <ul className="settings-bento-destinations" role="list">
                    {group.destinations.map(({page, note}) => {
                      const item = available.get(page);
                      return item && <li key={page}>
                        <button type="button" className="settings-bento-destination" onClick={() => onPage(page)}>
                          <span className="settings-bento-destination-icon"><Glyph name={item.icon} size={16}/></span>
                          <span className="settings-bento-destination-copy"><strong>{item.label}</strong><small>{note}</small></span>
                          <Glyph name="next" size={14}/>
                        </button>
                      </li>;
                    })}
                  </ul>
                </section>;
              })}
            </div>
          </div>
        </div>
      </section>
    </div>
  </section>;
}
