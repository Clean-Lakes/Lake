// Isolated fictional objects. No backend, model, credential or file requests.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AssistantMarkdown, ObjectReferencesProvider, ReplyReferenceScope} from '../../src/AssistantMarkdown';
import {SREProse} from '../../src/SREReport';
import {Glyph} from '../../src/Icons';
import type {AICard, Resource} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/assistantProse.css';
import '../../src/objectReferences.css';
import '../../src/sreCollaboration.css';
const theme = new URLSearchParams(location.search).get('theme') || 'light';
document.documentElement.dataset.theme = theme;
const resources: Resource[] = [
  {id: 'demo-source', projectId: 'demo', name: '141 源库', kind: 'database', description: '', status: 'available', settings: {host: '192.0.2.141', port: 5432}},
  {id: 'demo-target', projectId: 'demo', name: '78 目标库', kind: 'database', description: '', status: 'available', settings: {host: '192.0.2.78', port: 5432}},
  {id: 'demo-host', projectId: 'demo', name: '测试服务器', kind: 'ssh', description: '', status: 'available', ssh: {host: '192.0.2.21', port: 22, username: 'operator'}},
];
const cards: AICard[] = [{id: 'file', type: 'diff', title: '/etc/nginx/nginx.conf', status: 'completed', at: '2026-10-22T08:00:00Z', data: {runtime: 'ssh', assetRef: 'demo-host', before: '', after: '# 会话中保存的演示配置\nevents {}\nhttp { server { listen 8080; } }\n', existed: false}}];
const comparison = '两台数据库的 PostgreSQL 15.8、PostGIS 3.4.3 版本一致，编码与时区一致。6 项差异均为性能配置，不影响 dump/restore 兼容性。\n\n141 源库 → 78 目标库\n\n| 参数 | 源库 | 目标库 |\n| --- | ---: | ---: |\n| `shared_buffers` | 128 MB | 8 GB |\n| `max_connections` | 100 | 500 |\n| `work_mem` | 4 MB | 32 MB |\n| `maintenance_work_mem` | 64 MB | 1 GB |\n| `effective_cache_size` | 4 GB | 18 GB |\n| `wal_compression` | off | pglz |\n\n切换后留意连接池配置与活跃连接数，以及 WAL 压缩带来的 CPU 开销。';
const investigation = '测试服务器上的 Nginx 1.26.2 未启动，已更新 `/etc/nginx/nginx.conf`。\n\n配置检查已通过，服务尚未重启。`systemctl restart nginx` 保留为命令。\n\n数据库连接由 PostgreSQL 15.8 提供。';
function Fixture() {
  const [mode, setMode] = useState('comparison');
  const text = mode === 'comparison' ? comparison : investigation;
  return <div className="reference-fixture">
    <aside><span className="reference-brand">Lake <small>DEV</small></span><p><Glyph name="folder" size={16}/>演示项目</p><nav><button onClick={() => setMode('comparison')} aria-pressed={mode === 'comparison'}>数据库迁移对比</button><button onClick={() => setMode('investigation')} aria-pressed={mode === 'investigation'}>服务故障排查</button><button onClick={() => setMode('sre')} aria-pressed={mode === 'sre'}>SRE 回复</button></nav><p className="reference-section">资源</p>{resources.map(resource => <p key={resource.id}><Glyph name={resource.kind === 'database' ? 'database' : 'server'} size={15}/>{resource.name}</p>)}</aside>
    <main><header>演示项目 / {mode === 'comparison' ? '数据库迁移对比' : '服务故障排查'}</header><section className="reference-reading"><div className="reference-question">{mode === 'comparison' ? '对比一下 141 和 78 的 PostgreSQL 版本和配置' : '检查测试服务器上的 Nginx 配置'}</div><p className="reference-status">已核对资源与配置</p><ObjectReferencesProvider resources={resources}><ReplyReferenceScope cards={cards}>{mode === 'sre' ? <SREProse>{text}</SREProse> : <AssistantMarkdown>{text}</AssistantMarkdown>}</ReplyReferenceScope></ObjectReferencesProvider></section><footer><div>想让 Lake 帮你做什么？<Glyph name="up" size={18}/></div><small>＋　权限<span>默认模型　 默认</span></small></footer></main>
    <style>{`.reference-fixture{display:grid;grid-template-columns:250px minmax(0,1fr);min-height:100dvh;font:14px/1.8 var(--font-ui);color:var(--foreground);background:var(--background)}.reference-fixture aside{padding:32px 20px;background:var(--sidebar)}.reference-brand{font-size:24px}.reference-brand small{font-size:10px;color:var(--text-muted);margin-left:8px}.reference-fixture aside p{display:flex;align-items:center;gap:9px;margin:24px 0}.reference-fixture nav{display:grid;gap:6px}.reference-fixture nav button{padding:8px 12px;text-align:left;border:0;background:none;color:var(--text-secondary);font:inherit;border-radius:6px}.reference-fixture nav button[aria-pressed=true]{background:var(--surface-selected);color:var(--foreground)}.reference-section{color:var(--text-muted);font-size:12px}.reference-fixture main{min-width:0;display:flex;flex-direction:column;padding:24px 48px}.reference-fixture main>header{align-self:flex-start;padding:7px 16px;border:1px solid var(--border);border-radius:var(--radius-window);font-size:13px}.reference-reading{width:100%;max-width:860px;margin:32px auto;flex:1;min-width:0}.reference-question{margin:0 0 28px auto;padding:10px 16px;background:var(--surface-muted);border-radius:var(--radius-window);width:fit-content;max-width:100%}.reference-status{font-size:12px;color:var(--text-muted);margin-bottom:30px}.reference-fixture footer{width:100%;max-width:860px;align-self:center;margin-top:32px;color:var(--text-muted)}.reference-fixture footer>div{display:flex;justify-content:space-between;padding:14px 18px;border:1px solid var(--border-strong);border-radius:var(--radius-window)}.reference-fixture footer small{display:block;padding:12px 6px}.reference-fixture footer small span{float:right}@media(max-width:700px){.reference-fixture{grid-template-columns:1fr}.reference-fixture aside{display:none}.reference-fixture main{padding:20px 24px}.reference-reading{margin:24px auto}.reference-fixture main>header{max-width:100%;box-sizing:border-box}}`}</style>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
