// Shared by the browser bundle and WKWebView, including pages served by an older running backend.
(() => {
  if (typeof window === 'undefined') return;
  if (window.lakeWorkbenchLayout) return;
  window.lakeWorkbenchLayout = true;
  const key = 'lake.workbench.widths';
  let preferred = { sidebar: 280, terminal: 400, inspector: 382 };
  try {
    const saved = window.lakeWorkbenchWidths || JSON.parse(localStorage.getItem(key) || '{}');
    for (const pane of ['sidebar', 'terminal', 'inspector']) {
      const [min, max] = pane === 'sidebar' ? [200, 420] : [240, 900];
      if (Number.isFinite(saved[pane]) && saved[pane] >= min && saved[pane] <= max) preferred[pane] = saved[pane];
    }
  } catch { /* Storage can be unavailable in private browsing. */ }
  const style = document.createElement('style');
  style.textContent = `
    .workbench-splitter { position:absolute; top:0; bottom:0; width:8px; z-index:35; cursor:col-resize; touch-action:none; outline:none; }
    .workbench-splitter:hover::after, .workbench-splitter:focus-visible::after { content:''; position:absolute; top:0; bottom:0; left:3px; width:2px; background:var(--focus); }
    .workbench-splitter-sidebar { left:calc(var(--sidebar-width) - 4px); }
    .workbench-splitter-sidebar:hover:not(:focus-visible)::after { width:1px; background:var(--border-strong); }
    .workbench-splitter-terminal, .workbench-splitter-inspector { left:0; }
    .workbench-splitter-terminal::after, .workbench-splitter-inspector::after { left:0; }
    .workbench-resizing .session-inspector { animation:none !important; }
    .workbench-resizing, .workbench-resizing * { cursor:col-resize !important; user-select:none !important; }
    .workbench-resizing .app-shell, .workbench-resizing .terminal-side-panel { transition:none !important; }
    .ai-context-panel { position:fixed; z-index:60; bottom:auto; right:auto; overflow-y:auto; }
    @media(min-width:768px) {
      .app-shell { position:relative; grid-template-columns:var(--sidebar-width, 280px) minmax(0,1fr) 0px; }
      .app-shell.terminal-is-open { grid-template-columns:var(--sidebar-width, 280px) minmax(0,1fr) var(--terminal-panel-width); }
      .terminal-side-panel { position:relative; }
    }
    @media(min-width:768px) and (max-width:1100px) {
      .app-shell, .app-shell.terminal-is-open { grid-template-columns:var(--sidebar-width, 280px) minmax(0,1fr) 0px; }
    }
    @media(max-width:767px) { .workbench-splitter { display:none; } }
  `;
  document.head.appendChild(style);
  let shell, active, frame = 0, lastChrome = '';
  let observedContextPanel;
  const contextResize = new ResizeObserver(() => schedule());
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  function limits(pane) {
    const width = shell?.clientWidth || innerWidth;
    const desktop = innerWidth > 1100;
    const inspectorOpen = desktop && !!shell.querySelector('.session-inspector.is-open');
    const terminalOpen = desktop && shell.classList.contains('terminal-is-open');
    // All open panes share one budget. Reserving the conversation independently
    // for each side pane can otherwise spend that same space twice after zooming.
    const conversationMin = desktop ? 416 : 320;
    const auxiliaryMin = inspectorOpen && terminalOpen ? 240 : 280;
    const sidebarMax = Math.max(200, Math.min(420, width - conversationMin - (terminalOpen ? auxiliaryMin : 0) - (inspectorOpen ? auxiliaryMin : 0)));
    const sidebar = clamp(preferred.sidebar, 200, sidebarMax);
    const terminalMax = Math.max(auxiliaryMin, Math.min(900, width - sidebar - conversationMin - (inspectorOpen ? auxiliaryMin : 0)));
    const terminal = terminalOpen ? clamp(preferred.terminal, auxiliaryMin, terminalMax) : 0;
    if (pane === 'sidebar') return [200, sidebarMax];
    if (pane === 'terminal') return desktop ? [auxiliaryMin, terminalMax] : [280, Math.max(280, Math.min(900, width - 40))];
    if (desktop) return [auxiliaryMin, Math.max(auxiliaryMin, Math.min(900, width - sidebar - terminal - conversationMin))];
    const workspace = shell.querySelector('.workspace');
    return [280, Math.max(280, Math.min(900, (workspace?.clientWidth || 0) - (innerWidth <= 700 ? 0 : 320)))];
  }
  function save() {
    try { localStorage.setItem(key, JSON.stringify(preferred)); } catch {}
    // The native backend can use a different loopback port next launch, so persist outside its origin too.
    window.webkit?.messageHandlers?.lakeChrome?.postMessage({ widths: preferred });
  }
  function apply() {
    if (!shell) return;
    for (const pane of ['sidebar', 'terminal', 'inspector']) {
      const [min, max] = limits(pane);
      const width = clamp(preferred[pane], min, max);
      shell.style.setProperty(pane === 'sidebar' ? '--sidebar-width' : pane === 'terminal' ? '--terminal-panel-width' : '--inspector-preferred-width', `${width}px`);
      const handle = shell.querySelector(`.workbench-splitter-${pane}`);
      if (handle) for (const [name, value] of [['valuemin', min], ['valuemax', max], ['valuenow', width]]) handle.setAttribute(`aria-${name}`, String(value));
    }
  }
  function addHandle(parent, pane) {
    if (parent.querySelector(`:scope > .workbench-splitter-${pane}`)) return;
    const handle = document.createElement('div');
    handle.className = `workbench-splitter workbench-splitter-${pane}`;
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', pane === 'sidebar' ? '调整项目导航宽度' : pane === 'terminal' ? '调整终端宽度' : '调整任务检查宽度');
    handle.title = '拖动调整宽度，双击恢复默认；方向键微调';
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const element = shell.querySelector(pane === 'sidebar' ? '.sidebar' : pane === 'terminal' ? '.terminal-side-panel' : '.session-inspector');
      active = { pane, x: event.clientX, width: element.getBoundingClientRect().width, pointer: event.pointerId };
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('is-dragging');
      document.documentElement.classList.add('workbench-resizing');
    });
    handle.addEventListener('pointermove', event => {
      if (!active || active.pointer !== event.pointerId) return;
      const [min, max] = limits(pane);
      preferred[pane] = clamp(active.width + (event.clientX - active.x) * (pane === 'sidebar' ? 1 : -1), min, max);
      apply();
      schedule();
    });
    const finish = () => { active = null; handle.classList.remove('is-dragging'); document.documentElement.classList.remove('workbench-resizing'); save(); };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish);
    handle.addEventListener('dblclick', () => { preferred[pane] = pane === 'sidebar' ? 280 : pane === 'terminal' ? 400 : 382; apply(); save(); schedule(); });
    handle.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const [min, max] = limits(pane);
      const current = Number(handle.getAttribute('aria-valuenow'));
      const delta = (event.key === 'ArrowRight' ? 1 : -1) * (pane === 'sidebar' ? 1 : -1) * (event.shiftKey ? 50 : 10);
      preferred[pane] = event.key === 'Home' ? min : event.key === 'End' ? max : clamp(current + delta, min, max);
      apply(); save(); schedule();
    });
    parent.appendChild(handle);
  }
  function syncChrome() {
    const bridge = window.webkit?.messageHandlers?.lakeChrome;
    if (!bridge || !shell) return;
    const rect = element => { const r = element.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
    const headers = [...shell.querySelectorAll('.workspace-header, .terminal-panel-header, .session-inspector-heading')].filter(element => element.getBoundingClientRect().width > 0 && !element.closest('[aria-hidden="true"]') && getComputedStyle(element).visibility !== 'hidden');
    const sidebar = shell.querySelector('.sidebar');
    const height = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lake-titlebar-height')) || 52;
    const regions = headers.map(rect);
    // Floating headers no longer fill this strip; its empty space remains a titlebar.
    const workspace = shell.querySelector('.workspace');
    if (workspace) { const r = workspace.getBoundingClientRect(); regions.push([r.x, 0, r.width, height]); }
    if (sidebar) { const r = sidebar.getBoundingClientRect(); regions.push([r.x, 0, r.width, height]); }
    const excluded = [...shell.querySelectorAll('.workbench-splitter'), ...headers.flatMap(header => [...header.querySelectorAll('button, a, input, select, textarea, [role="button"]')])].map(rect);
    for (const element of document.querySelectorAll('.modal-scrim, dialog[open], [role="dialog"], [role="menu"], [role="listbox"]')) excluded.push(rect(element));
    const body = JSON.stringify({ regions, excluded, theme: document.documentElement.dataset.theme || 'light', appearance: window.lakeAppearance || 'light' });
    if (body !== lastChrome) { lastChrome = body; bridge.postMessage(JSON.parse(body)); }
  }
  function placeContextPanel() {
    const panel = shell.querySelector('.ai-context-panel');
    const trigger = shell.querySelector('.ai-context-trigger');
    const workspace = trigger?.closest('.workspace');
    if (panel !== observedContextPanel) {
      contextResize.disconnect();
      observedContextPanel = panel;
      for (const element of [panel, trigger, workspace]) if (element) contextResize.observe(element);
    }
    if (!panel || !trigger || !workspace) return;
    const bounds = workspace.getBoundingClientRect();
    const anchor = trigger.getBoundingClientRect();
    const leftEdge = Math.max(12, bounds.left + 12);
    const rightEdge = Math.min(innerWidth - 12, bounds.right - 12);
    const width = Math.max(1, Math.min(330, rightEdge - leftEdge));
    const header = workspace.querySelector('.workspace-header')?.getBoundingClientRect();
    const topEdge = Math.max(12, (header?.bottom ?? bounds.top) + 12);
    panel.style.width = `${width}px`;
    panel.style.maxHeight = `${Math.max(1, innerHeight - topEdge - 12)}px`;
    panel.style.left = `${clamp(anchor.left + anchor.width / 2 - width / 2, leftEdge, Math.max(leftEdge, rightEdge - width))}px`;
    const height = panel.getBoundingClientRect().height;
    const above = anchor.top - height - 9;
    const top = above >= topEdge ? above : anchor.bottom + 9 + height <= innerHeight - 12 ? anchor.bottom + 9 : topEdge;
    panel.style.top = `${clamp(top, topEdge, Math.max(topEdge, innerHeight - height - 12))}px`;
  }
  function sync() {
    frame = 0;
    shell = document.querySelector('.app-shell');
    if (!shell) return;
    addHandle(shell, 'sidebar');
    const terminal = shell.querySelector('.terminal-side-panel');
    if (terminal) addHandle(terminal, 'terminal');
    const inspector = shell.querySelector('.session-inspector.is-open');
    if (inspector) addHandle(inspector, 'inspector');
    apply(); syncChrome(); placeContextPanel();
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(sync); }
  new MutationObserver(schedule).observe(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:['class'] });
  new MutationObserver(schedule).observe(document.documentElement, { attributes:true, attributeFilter:['data-theme'] });
  window.addEventListener('resize', schedule);
  // React pane toggles must settle widths in the same commit, before paint.
  window.addEventListener('lake-workbench-layout', sync);
  document.addEventListener('scroll', schedule, true);
  window.addEventListener('lake-chrome-resize', schedule);
  document.addEventListener('transitionend', event => { if (event.target.matches('.app-shell, .terminal-side-panel')) schedule(); });
  schedule();
})();
