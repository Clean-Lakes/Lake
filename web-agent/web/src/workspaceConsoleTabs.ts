import type {GlyphName} from './Icons';

export type SettingsPage = 'channels' | 'appearance' | 'conversation' | 'memory' | 'watchdog' | 'agents' | 'models' | 'mcp' | 'skills';
export type ConsolePage = SettingsPage | 'workspace' | 'updates';
type Category = {
  key: ConsolePage;
  label: string;
  icon: GlyphName;
  keywords: string;
  typescriptOnly?: boolean;
};

const categories: readonly {label: string; showLabel?: boolean; items: readonly Category[]}[] = [
  {label: '工作区', items: [
    {key: 'channels', label: '接入渠道', icon: 'filter', keywords: '连接 客户端 路由 MCP', typescriptOnly: true},
    {key: 'appearance', label: '外观', icon: 'palette', keywords: '主题 深色 浅色 配色 颜色'},
    {key: 'conversation', label: '对话', icon: 'chat', keywords: '消息 会话 发送 快捷键'},
    {key: 'workspace', label: '项目', icon: 'folder', keywords: '切换 工作区'},
    {key: 'memory', label: '记忆', icon: 'book', keywords: '偏好 知识'},
    {key: 'watchdog', label: '巡检', icon: 'lakeSchedule', keywords: '任务 定时', typescriptOnly: true},
  ]},
  {label: 'Pilot', showLabel: true, items: [
    {key: 'agents', label: 'Agent 执行器', icon: 'terminal', keywords: 'Codex 执行器'},
    {key: 'models', label: 'Pilot 模型', icon: 'brain', keywords: '供应商 默认模型 思考强度'},
    {key: 'mcp', label: 'MCP 工具', icon: 'plug', keywords: '服务 服务器'},
    {key: 'skills', label: 'Skills', icon: 'spark', keywords: '技能'},
  ]},
  {label: '应用', showLabel: true, items: [
    {key: 'updates', label: '检查更新', icon: 'refresh', keywords: '版本 安装'},
  ]},
];

export function consoleCategories(typescriptBackend: boolean, query: string) {
  const terms = query.normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean);
  return categories.map(group => ({
    ...group,
    items: group.items.filter(category => (!category.typescriptOnly || typescriptBackend) &&
      terms.every(term => `${category.label} ${category.key} ${category.keywords}`.toLowerCase().includes(term))),
  })).filter(group => group.items.length > 0);
}

export function consoleCategoryLabel(page: ConsolePage) {
  return categories.flatMap(group => group.items).find(item => item.key === page)?.label;
}

export function availableSettingsPage(page: SettingsPage, typescriptBackend: boolean): SettingsPage {
  if (typescriptBackend) return page;
  if (page === 'channels') return 'models';
  if (page === 'watchdog') return 'conversation';
  return page;
}

export function consoleTabId(page: ConsolePage) {
  return page === 'workspace' || page === 'updates' ? `${page}-console-tab`
    : `${page === 'models' ? 'model' : page}-settings-tab`;
}

export function consolePanelId(page: ConsolePage) {
  if (page === 'workspace') return 'workspace-page';
  if (page === 'updates') return 'workspace-updates-page';
  return `${page === 'models' ? 'model' : page}-settings-panel`;
}
