import type {AgentRun, Resource} from '../../shared/contracts';
import type {FileChange} from './file-changes-model';

export type ObjectReference = {
  key: string;
  kind: 'resource' | 'software' | 'file' | 'task';
  label: string;
  icon: string;
  description: string;
  resource?: Resource;
  file?: FileChange;
  task?: AgentRun;
};
export type ObjectCatalog = {aliases: Map<string, ObjectReference | null>};
type ProseNode = {
  type: string;
  value?: string;
  children?: ProseNode[];
  data?: {hName?: string; hProperties?: Record<string, unknown>};
};

const software = [
  ['PostgreSQL', 'database', '数据库软件'], ['PostGIS', 'box', '数据库扩展'],
  ['MySQL', 'database', '数据库软件'], ['MariaDB', 'database', '数据库软件'],
  ['MongoDB', 'database', '数据库软件'], ['ClickHouse', 'database', '数据库软件'],
  ['SQLite', 'database', '数据库软件'], ['Redis', 'redis', '缓存服务'],
  ['Nginx', 'network', 'Web 服务'], ['Tomcat', 'box', '应用服务'],
  ['Elasticsearch', 'database', '搜索服务'], ['RabbitMQ', 'network', '消息服务'],
  ['Docker', 'docker', '容器运行时'], ['Kubernetes', 'layers', '容器编排'],
  ['Node.js', 'code', '运行时'], ['Python', 'code', '运行时'],
] as const;
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const softwarePattern = new RegExp(`(?:${software.map(([name]) => escapePattern(name)).join('|')})(?:[ \\t]+v?\\d+(?:\\.\\d+){0,3}(?:[-+][a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?)?`, 'gi');
const pathPattern = /(?:[a-zA-Z]:[\\/]|\/|\.\.?\/)[^\s<>"'`，。；：、！？（）\[\]{}()]+/gu;
const filePattern = /[\w.-]+\.(?:conf|config|log|json|ya?ml|toml|ini|env|md|txt|csv|sql|sh|tsx?|jsx?|py|go|html|css|xml)\b/gi;
const resourceNames = {local: '本机', ssh: 'SSH 主机', database: '数据库', docker: '容器资源', redis: 'Redis 资源'};

function addAlias(catalog: ObjectCatalog, alias: string, reference: ObjectReference) {
  const key = alias.trim().toLowerCase();
  if (key.length < 2) return;
  const previous = catalog.aliases.get(key);
  catalog.aliases.set(key, previous === undefined || previous?.key === reference.key ? reference : null);
}

export function objectCatalog(resources: readonly Resource[] = [], files: readonly FileChange[] = [], tasks: readonly AgentRun[] = []): ObjectCatalog {
  const catalog: ObjectCatalog = {aliases: new Map()};
  for (const resource of resources) {
    const reference: ObjectReference = {key: `resource:${resource.id}`, kind: 'resource', label: resource.name, icon: resource.kind === 'ssh' ? 'server' : resource.kind, description: `${resourceNames[resource.kind]} · ${resource.name}`, resource};
    addAlias(catalog, resource.name, reference);
    if (resource.id.length >= 8) addAlias(catalog, resource.id, reference);
    const host = resource.ssh?.host ?? resource.settings?.host;
    if (typeof host === 'string' && host.length >= 3 && /[.:]/.test(host)) addAlias(catalog, host, reference);
  }
  for (const file of files) {
    const reference: ObjectReference = {key: `file:${file.id}`, kind: 'file', label: file.path, icon: 'document', description: `会话文件 · ${file.path}`, file};
    addAlias(catalog, file.path, reference);
    addAlias(catalog, file.path.replaceAll('\\', '/').split('/').at(-1) ?? '', reference);
  }
  for (const task of tasks) {
    if (!task.name?.trim() || task.name.trim().length < 4) continue;
    addAlias(catalog, task.name, {key: `task:${task.id}`, kind: 'task', label: task.name, icon: 'layers', description: `任务 · ${task.name}`, task});
  }
  return catalog;
}

// Tokens inside URLs, identifiers, paths and options are not prose references.
function boundary(text: string, start: number, end: number) {
  const value = text.slice(start, end), before = text[start - 1] ?? '', after = text[end] ?? '';
  if (/^[/.\\]/.test(value) && /[\w:/\\]/.test(before)) return false;
  if (/^[\w]/.test(value) && /[\w/@.\\:\-]/.test(before)) return false;
  if (/[\w]$/.test(value) && /[\w/@\\\-]/.test(after)) return false;
  if (after === '.' && /\w/.test(text[end + 1] ?? '')) return false;
  const tokenStart = Math.max(text.lastIndexOf(' ', start - 1), text.lastIndexOf('\n', start - 1), text.lastIndexOf('\t', start - 1)) + 1;
  return !/https?:\/\/|[\w.+-]+:\/\//i.test(text.slice(tokenStart, start));
}

export type ObjectMatch = {start: number; end: number; reference: ObjectReference};
export function objectMatches(text: string, catalog: ObjectCatalog): ObjectMatch[] {
  const candidates: (ObjectMatch & {priority: number})[] = [];
  const aliases = [...catalog.aliases.keys()].sort((a, b) => b.length - a.length);
  if (aliases.length) {
    const pattern = new RegExp(aliases.map(escapePattern).join('|'), 'gi');
    for (const match of text.matchAll(pattern)) {
      const start = match.index!, end = start + match[0].length;
      const reference = catalog.aliases.get(match[0].toLowerCase());
      if (boundary(text, start, end)) candidates.push({start, end, priority: 3, reference: reference ? {...reference, label: match[0]} : {key: '', kind: 'resource', label: match[0], icon: '', description: ''}});
    }
  }
  for (const match of text.matchAll(softwarePattern)) {
    const start = match.index!, end = start + match[0].length;
    if (!boundary(text, start, end)) continue;
    const [name, icon, description] = software.find(([name]) => match[0].toLowerCase().startsWith(name.toLowerCase()))!;
    const alias = catalog.aliases.get(name.toLowerCase());
    if (catalog.aliases.has(name.toLowerCase())) {
      // A version suffix must not turn an ambiguous resource into a software link.
      candidates.push({start, end, priority: 4, reference: alias ? {...alias, label: match[0]} : {key: '', kind: 'resource', label: match[0], icon: '', description: ''}});
    } else candidates.push({start, end, priority: 1, reference: {key: `software:${match[0].toLowerCase()}`, kind: 'software', label: match[0], icon, description: `${description} · ${match[0]}（文字引用）`}});
  }
  for (const pattern of [pathPattern, filePattern]) {
    for (const match of text.matchAll(pattern)) {
      const label = match[0].replace(/[.,;:!?]+$/g, '');
      const start = match.index!, end = start + label.length;
      if (!boundary(text, start, end) || !label || label === '/') continue;
      const known = catalog.aliases.get(label.toLowerCase());
      if (catalog.aliases.has(label.toLowerCase())) {
        candidates.push({start, end, priority: 3, reference: known ? {...known, label} : {key: '', kind: 'file', label, icon: '', description: ''}});
      } else if (/[\\/]/.test(label) || pattern === filePattern) {
        candidates.push({start, end, priority: 2, reference: {key: `path:${label}`, kind: 'file', label, icon: 'document', description: `文件路径 · ${label}（尚无会话文件预览）`}});
      }
    }
  }
  candidates.sort((a, b) => a.start - b.start || b.end - a.end || b.priority - a.priority);
  const matches: ObjectMatch[] = [];
  let end = -1;
  for (const candidate of candidates) {
    if (candidate.start < end) continue;
    end = candidate.end;
    if (candidate.reference.key) matches.push(candidate);
  }
  return matches;
}

const skipped = new Set(['code', 'link', 'linkReference', 'image', 'imageReference', 'html', 'objectReference', 'sessionTag']);
export function remarkObjectReferences(catalog: ObjectCatalog) {
  return () => (tree: ProseNode) => {
    function visit(node: ProseNode) {
      if (!node.children || skipped.has(node.type)) return;
      node.children = node.children.flatMap(child => {
        if (!['text', 'inlineCode'].includes(child.type) || !child.value) { visit(child); return [child]; }
        const matches = objectMatches(child.value, catalog);
        // A command in inline code remains a command. Only a whole object token
        // may replace inline-code formatting; fenced code never reaches here.
        if (child.type === 'inlineCode' && !(matches.length === 1 && matches[0]!.start === 0 && matches[0]!.end === child.value.length)) return [child];
        const pieces: ProseNode[] = [];
        let offset = 0;
        for (const {start, end, reference} of matches) {
          if (start > offset) pieces.push({type: 'text', value: child.value.slice(offset, start)});
          pieces.push({type: 'objectReference', data: {hName: 'span', hProperties: {'data-object-key': reference.key, 'data-object-label': reference.label}}, children: [{type: 'text', value: reference.label}]});
          offset = end;
        }
        if (!pieces.length) return [child];
        if (offset < child.value.length) pieces.push({type: 'text', value: child.value.slice(offset)});
        return pieces;
      });
    }
    visit(tree);
  };
}
