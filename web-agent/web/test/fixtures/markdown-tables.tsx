// Presentation-only synthetic data. No backend, model or resource is accessed.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {AssistantMarkdown} from '../../src/AssistantMarkdown';
import {SREProse} from '../../src/SREReport';
import '../../src/styles.css';
import '../../src/sreCollaboration.css';
import '../../src/assistantProse.css';
import '../../src/objectReferences.css';

const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
window.fetch = async () => { throw new Error('The table fixture cannot access a backend.'); };
const report = `六服务日志对比，以下均为隔离模拟数据。

| 服务 | 日志来源 | 总行数 现/基/Δ | ERROR 现/基/Δ | WARN 现/基/Δ | replicas 现/基 | running / failed_units / restart_count |
| --- | --- | --- | --- | --- | --- | --- |
${Array.from({length: 6}, (_, i) => `| service-${i + 1} | \`service-${i + 1}/${i === 2 ? 'rotated-current.log' : 'current.log'}\`${i === 2 ? '（同目录替代）' : ''} | 4000/4000/0 | ${8 + i}/${6 + i}/+2 | ${14 + i}/${14 + i}/0 | 3/3 | true / 0 / 0 |`).join('\n')}

表格保持完整列宽，横向滚动只发生在表格内部。来源文件：\`/var/log/messages\`。

| 检查项 | 说明 |
| --- | --- |
| 长说明 | ${'这是一段用于检验自然换行的说明，保留正常阅读宽度。'.repeat(12)} |
`;

const Wrapper = query.get('view') === 'sre' ? SREProse : AssistantMarkdown;
createRoot(document.getElementById('root')!).render(<main style={{width: 'calc(100% - 48px)', maxWidth: query.get('width') === '390' ? 390 : 860, margin: '24px auto', minWidth: 0}}>
  <p style={{color: 'var(--text-muted)', fontSize: 'var(--font-size-ui)'}}>Lake · {query.get('view') === 'sre' ? 'Pilot 报告' : '普通回复'} · 隔离表格验收</p>
  <Wrapper>{report}</Wrapper>
</main>);
