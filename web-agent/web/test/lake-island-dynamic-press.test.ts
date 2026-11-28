import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {SpecialistChannelInfo} from '../../shared/contracts';
import {LakeIslandCompactLive, LakeIslandDrawer} from '../src/LakeIslandDrawer';
import {
  centeredIslandLeft,
  expandedIslandWidth,
  ISLAND_DRAG_CANCEL_PX,
  ISLAND_EXPANDED_WIDTH,
  ISLAND_LONG_PRESS_MS,
  ISLAND_PRESS_SWELL_MS,
  isIslandPressTarget,
} from '../src/lakeIslandPress';
import type {PilotParticipant} from '../src/superPilotActivity';

const css = registerHooks({load(url, context, nextLoad) { return url.endsWith('.css') ? {format: 'module', source: 'export {};', shortCircuit: true} : nextLoad(url, context); }});
const {WorkbenchIsland} = await import('../src/WorkbenchIsland');
css.deregister();

test('the island centers within the pane and handles only its own press area', () => {
  assert.equal(ISLAND_PRESS_SWELL_MS, 110);
  assert.equal(ISLAND_LONG_PRESS_MS, 260);
  assert.equal(ISLAND_EXPANDED_WIDTH, 392);
  assert.equal(ISLAND_DRAG_CANCEL_PX, 8);

  assert.equal(expandedIslandWidth(240, 600), 392);
  assert.equal(expandedIslandWidth(240, 320), 320);
  assert.equal(expandedIslandWidth(240, 180), 240);

  // Centers inside pane [280, 1080] while keeping right directory lane [..., 1004] clear
  assert.equal(centeredIslandLeft(280, 800, 260, 296, 1004), 550);
  assert.equal(centeredIslandLeft(280, 420, 392, 296, 624), 296);

  const avatar = {closest: () => ({} as Element)} as unknown as Element;
  const plainTitle = {closest: () => null} as unknown as Element;
  const statusMark = {closest: () => null} as unknown as Element;
  const portalRow = {closest: () => null} as unknown as Element;
  const islandRoot = {
    closest: () => null,
    contains: (target: Element) => [islandRoot, avatar, plainTitle, statusMark].includes(target),
  } as unknown as Element;

  assert.equal(isIslandPressTarget(islandRoot, islandRoot), true);
  assert.equal(isIslandPressTarget(plainTitle, islandRoot), true);
  assert.equal(isIslandPressTarget(statusMark, islandRoot), true);
  assert.equal(isIslandPressTarget(avatar, islandRoot), false);
  assert.equal(isIslandPressTarget(portalRow, islandRoot), false);
});

test('LakeIslandDrawer matches unified Dynamic Island card layout across running, waiting, and idle states', () => {
  const runningParticipants: PilotParticipant[] = [
    {key: 'obs', roleId: 'obs', name: '发布专员', detail: '核查抓帧链路', moving: true},
    {key: 'owl', roleId: 'owl', name: '应用专员', detail: '比对 Inspector 指标', moving: false},
  ];
  const channels: SpecialistChannelInfo[] = [
    {id: 'c1', projectId: 'p', roleId: 'obs', roleName: '发布专员', sessionId: 's1', revision: 1, createdAt: ''},
    {id: 'c2', projectId: 'p', roleId: 'owl', roleName: '应用专员', sessionId: 's2', revision: 1, createdAt: ''},
  ];

  const runningHtml = renderToStaticMarkup(createElement(LakeIslandDrawer, {
    title: '可观测群',
    statusLabel: '处理中',
    elapsedLabel: '01:23',
    tone: 'active',
    pilot: true,
    running: true,
    participants: runningParticipants,
    inspectorAvailable: true,
    stoppable: true,
    onToggleInspector() {},
    onStop() {},
    onClose() {},
  }));
  assert.match(runningHtml, /可观测群 · 1 位专员协作中/);
  assert.match(runningHtml, /本次排查已持续 01:23/);
  assert.match(runningHtml, /class="lake-island-dots" role="img" aria-label="处理中"/);
  assert.match(runningHtml, /class="lake-island-participant-row" title="发布专员 · 核查抓帧链路"/);
  assert.match(runningHtml, /执行中/);
  assert.match(runningHtml, /收起小岛/);
  assert.match(runningHtml, /查看过程/);
  assert.match(runningHtml, /停止全部任务/);

  const waitingHtml = renderToStaticMarkup(createElement(LakeIslandDrawer, {
    title: '发布工作群',
    statusLabel: '等待确认',
    tone: 'attention',
    waiting: true,
    participants: runningParticipants,
    onClose() {},
  }));
  assert.match(waitingHtml, /class="lake-island-wait-pill"/);
  assert.doesNotMatch(waitingHtml, /class="lake-island-dots"/);

  const idleHtml = renderToStaticMarkup(createElement(LakeIslandDrawer, {
    title: 'Lake',
    projectName: 'Zmy项目组',
    statusLabel: '待命',
    participants: [],
    channels,
    onClose() {},
  }));
  assert.match(idleHtml, /Lake · Zmy项目组/);
  assert.match(idleHtml, /class="lake-island-idle-dot"/);
  assert.match(idleHtml, /2 位专员就绪/);
  assert.match(idleHtml, /收起小岛/);
  assert.doesNotMatch(idleHtml, /停止全部任务/);
});

test('WorkbenchIsland exposes Style 3 interactive press attributes only when expandedPanel is wired', () => {
  const plain = renderToStaticMarkup(createElement(WorkbenchIsland, {
    conversation: () => createElement('div', null, 'header'),
    terminal: null,
    activity: null,
    terminalOpen: false,
  }));
  assert.doesNotMatch(plain, /data-island-interactive|island-expand-trigger|island-expand-drawer/);

  const interactive = renderToStaticMarkup(createElement(WorkbenchIsland, {
    conversation: ({expanded}) => createElement('header', {inert: expanded}, 'header'),
    terminal: null,
    activity: null,
    terminalOpen: false,
    sessionKey: 's1',
    expandedPanel: ({close}) => createElement(LakeIslandDrawer, {
      title: 'Lake',
      statusLabel: '待命',
      participants: [],
      onClose: close,
    }),
  }));
  assert.match(interactive, /data-island-interactive="true"/);
  assert.match(interactive, /data-island-phase="compact"/);
  assert.match(interactive, /data-island-press="idle"/);
  assert.match(interactive, /aria-label="展开小岛" aria-expanded="false" aria-controls=/);
  assert.match(interactive, /class="island-expand-drawer" data-open="false"/);
});

test('workbenchIsland.css and ConversationDirectory prevent bleed-through, double headers, and directory shifting', () => {
  const css = readFileSync(new URL('../src/workbenchIsland.css', import.meta.url), 'utf8');
  assert.match(css, /transform-origin:center top;/);
  assert.match(css, /color-mix\(in srgb,var\(--surface\) 98%,transparent\)/);
  assert.match(css, /\[data-island-phase="expanded"\] > \.workspace-header\s*\{[^}]*height:0;/);
  assert.match(css, /\[data-island-press="squish"\]/);
  assert.match(css, /\[data-island-press="swell"\]/);
  assert.match(css, /\.island-expand-drawer\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\)/);
  assert.match(css, /\.island-expand-drawer\[data-open="true"\][^}]*100ms/);
  assert.match(css, /width 480ms var\(--island-spring\) 90ms/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)/);

  const dir = readFileSync(new URL('../src/ConversationDirectory.tsx', import.meta.url), 'utf8');
  assert.match(dir, /--conversation-header-actions-offset/);
  assert.match(dir, /header!\.offsetTop/);
  assert.doesNotMatch(dir, /data-island-phase|compactBarHeight/);
});

test('AppContent declares no React hooks after conditional early returns and LakeIslandCompactLive renders timer markup', () => {
  const compactHtml = renderToStaticMarkup(createElement(LakeIslandCompactLive, {
    active: true,
    resetKey: 'session-1',
    label: '处理中',
  }));
  assert.match(compactHtml, /class="lake-island-compact-live"/);
  assert.match(compactHtml, /class="lake-island-dots" role="img" aria-label="处理中"/);
  assert.match(compactHtml, /class="lake-island-elapsed">00:00</);

  const appSrc = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const start = appSrc.indexOf('if (authRequired)');
  const end = appSrc.indexOf('\nfunction Brand(', start);
  assert.ok(start > 0 && end > start, 'Expected AppContent early return and Brand boundary in App.tsx');
  const afterEarlyReturn = appSrc.slice(start, end);
  assert.doesNotMatch(
    afterEarlyReturn,
    /\buse(?:State|Effect|LayoutEffect|Memo|Callback|Ref)\s*\(/,
    'React hooks must never execute conditionally after an early return in AppContent',
  );
});
