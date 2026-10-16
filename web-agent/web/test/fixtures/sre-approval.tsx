// Presentation-only approval fixture. Never submit a decision or call resources.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {AIPending} from '../../src/AIPanel';
import type {AIView} from '../../../shared/contracts';
import '../../src/theme.css';
import '../../src/styles.css';
import '../../src/sreCollaboration.css';
const view={pending:{id:'fixture',target:'测试主机',kind:'delete',risk:'dangerous',confirmation:'执行 测试主机',call:{name:'shell',arguments:JSON.stringify({command:'for p in 22 3306; do timeout 3 bash -c "echo > /dev/tcp/127.0.0.1/$p"; done'},null,2)}}} as AIView;
createRoot(document.getElementById('root')!).render(<main style={{maxWidth:760,margin:'32px auto',padding:24}}><h2>审批文案 · 隔离测试数据</h2><p>保留额外确认，避免将嵌套 Shell 检查直接描述为删除。</p><AIPending session="fixture-no-resource" agentName="调查员" runId="fixture" view={view} refresh={async()=>undefined}/></main>);
