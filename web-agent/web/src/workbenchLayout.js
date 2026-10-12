// Shared by the browser bundle and WKWebView, including pages served by an older running backend.
(() => {
  if (typeof window === 'undefined') return;
  if (window.lakeWorkbenchLayout) return;
  window.lakeWorkbenchLayout = true;
  const key = 'lake.workbench.widths';
  let preferred = { sidebar: 264, terminal: 448 };
  try {
    const saved = window.lakeWorkbenchWidths || JSON.parse(localStorage.getItem(key) || '{}');
    for (const pane of ['sidebar', 'terminal']) {
      const [min, max] = pane === 'sidebar' ? [200, 420] : [280, 900];
      if (Number.isFinite(saved[pane]) && saved[pane] >= min && saved[pane] <= max) preferred[pane] = saved[pane];
    }
  } catch { /* Storage can be unavailable in private browsing. */ }
  const style = document.createElement('style');
  style.textContent = `
    .workbench-splitter { position:absolute; top:0; bottom:0; width:8px; z-index:35; cursor:col-resize; touch-action:none; outline:none; }
    .workbench-splitter:hover::after, .workbench-splitter:focus-visible::after { content:''; position:absolute; top:0; bottom:0; left:3px; width:2px; background:#479488; }
    .workbench-splitter-sidebar { left:calc(var(--sidebar-width) - 4px); }
    .workbench-splitter-terminal { left:0; }
    .workbench-resizing, .workbench-resizing * { cursor:col-resize !important; user-select:none !important; }
    .workbench-resizing .app-shell, .workbench-resizing .terminal-side-panel { transition:none !important; }
    @media(min-width:768px) {
      .app-shell { position:relative; grid-template-columns:var(--sidebar-width, 264px) minmax(0,1fr) 0px; }
      .app-shell.terminal-is-open { grid-template-columns:var(--sidebar-width, 264px) minmax(0,1fr) var(--terminal-panel-width); }
      .terminal-side-panel { position:relative; }
    }
    @media(min-width:768px) and (max-width:1100px) {
      .app-shell, .app-shell.terminal-is-open { grid-template-columns:var(--sidebar-width, 264px) minmax(0,1fr) 0px; }
    }
    @media(max-width:767px) { .workbench-splitter { display:none; } }
  `;
  document.head.appendChild(style);
  let shell, active, frame = 0, lastChrome = '';
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  function limits(pane) {
    const width = shell?.clientWidth || innerWidth;
    const sidebar = clamp(preferred.sidebar, 200, Math.min(420, width - 320));
    const terminal = clamp(preferred.terminal, 280, Math.max(280, width - sidebar - 320));
    if (pane === 'sidebar') return [200, Math.max(200, Math.min(420, width - 320 - (width > 1100 && shell.classList.contains('terminal-is-open') ? terminal : 0)))];
    return [280, Math.max(280, Math.min(900, width <= 1100 ? width - 40 : width - sidebar - 320))];
  }
  function save() {
    try { localStorage.setItem(key, JSON.stringify(preferred)); } catch {}
    // The native backend can use a different loopback port next launch, so persist outside its origin too.
    window.webkit?.messageHandlers?.lakeChrome?.postMessage({ widths: preferred });
  }
  function apply() {
    if (!shell) return;
    for (const pane of ['sidebar', 'terminal']) {
      const [min, max] = limits(pane);
      const width = clamp(preferred[pane], min, max);
      shell.style.setProperty(pane === 'sidebar' ? '--sidebar-width' : '--terminal-panel-width', `${width}px`);
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
    handle.setAttribute('aria-label', pane === 'sidebar' ? '调整项目导航宽度' : '调整终端宽度');
    handle.title = '拖动调整宽度，双击恢复默认；方向键微调';
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const element = shell.querySelector(pane === 'sidebar' ? '.sidebar' : '.terminal-side-panel');
      active = { pane, x: event.clientX, width: element.getBoundingClientRect().width, pointer: event.pointerId };
      handle.setPointerCapture(event.pointerId);
      document.documentElement.classList.add('workbench-resizing');
    });
    handle.addEventListener('pointermove', event => {
      if (!active || active.pointer !== event.pointerId) return;
      const [min, max] = limits(pane);
      preferred[pane] = clamp(active.width + (event.clientX - active.x) * (pane === 'sidebar' ? 1 : -1), min, max);
      apply();
      schedule();
    });
    const finish = () => { active = null; document.documentElement.classList.remove('workbench-resizing'); save(); };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish);
    handle.addEventListener('dblclick', () => { preferred[pane] = pane === 'sidebar' ? 264 : 448; apply(); save(); schedule(); });
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
    const headers = [...shell.querySelectorAll('.workspace-header, .terminal-panel-header')].filter(element => element.getBoundingClientRect().width > 0);
    const sidebar = shell.querySelector('.sidebar');
    const height = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lake-titlebar-height')) || 52;
    const regions = headers.map(rect);
    if (sidebar) { const r = sidebar.getBoundingClientRect(); regions.push([r.x, 0, r.width, height]); }
    const excluded = [...shell.querySelectorAll('.workbench-splitter'), ...headers.flatMap(header => [...header.querySelectorAll('button, a, input, select, textarea, [role="button"]')])].map(rect);
    const body = JSON.stringify({ regions, excluded });
    if (body !== lastChrome) { lastChrome = body; bridge.postMessage(JSON.parse(body)); }
  }
  function sync() {
    frame = 0;
    shell = document.querySelector('.app-shell');
    if (!shell) return;
    addHandle(shell, 'sidebar');
    const terminal = shell.querySelector('.terminal-side-panel');
    if (terminal) addHandle(terminal, 'terminal');
    apply(); syncChrome();
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(sync); }
  new MutationObserver(schedule).observe(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:['class'] });
  window.addEventListener('resize', schedule);
  window.addEventListener('lake-chrome-resize', schedule);
  document.addEventListener('transitionend', event => { if (event.target.matches('.app-shell, .terminal-side-panel')) schedule(); });
  schedule();
})();
