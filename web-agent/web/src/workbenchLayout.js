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
    .conversation[data-sidebar-resizing] { overflow-x:hidden; }
    .app-shell > .workspace .conversation[data-sidebar-resizing] > .timeline-list { width:var(--sidebar-resize-reading-width); }
    .workspace.has-floating-header .conversation[data-sidebar-resizing] {
      --sidebar-resize-chat-room:max(0px,calc(100cqw - var(--inspector-width,0px) - var(--session-content-start) - var(--session-gutter)));
    }
    .workspace.has-floating-header .conversation[data-sidebar-resizing] .ai-role-user {
      translate:min(0px,calc(var(--sidebar-resize-chat-room) - var(--sidebar-resize-reading-width)));
      max-width:min(85%,calc(var(--sidebar-resize-chat-room) * .85));
    }
    .app-shell[data-sidebar-resize-layer] > :is(.workbench-conversation-surface,.workspace,.lake-workbench-islands,.workbench-navigation,.workbench-splitter-sidebar) { will-change:transform; }
    .app-shell[data-sidebar-resize-layer] > .sidebar .sidebar-navigation-content { inline-size:100%; }
    .app-shell[data-sidebar-resize-layer] > .workspace,
    .app-shell[data-sidebar-resize-layer] > .workspace :is(.session-layout,.session-layout > .session-view) { overflow:visible; }
    .app-shell[data-sidebar-resize-layer] .conversation { overflow-x:hidden; }
    .app-shell[data-sidebar-resize-layer] .composer-dock {
      width:var(--sidebar-resize-viewport);
      --session-content-width:min(960px,calc(var(--sidebar-resize-viewport) - var(--session-gutter) * 2));
      --session-content-start:max(var(--session-gutter),calc((var(--sidebar-resize-viewport) - 960px) / 2));
    }
    .workbench-splitter-terminal, .workbench-splitter-inspector { left:0; }
    .workbench-splitter-terminal::after, .workbench-splitter-inspector::after { left:0; }
    .workbench-resizing .session-inspector { animation:none !important; }
    .workbench-resizing, .workbench-resizing * { cursor:col-resize !important; user-select:none !important; }
    .workbench-resizing .app-shell, .workbench-resizing .terminal-side-panel { transition:none !important; }
    .ai-context-panel { position:fixed; z-index:60; bottom:auto; right:auto; overflow-y:auto; }
    @media(min-width:701px) {
      .app-shell { position:relative; grid-template-columns:var(--sidebar-width,280px) minmax(0,1fr) 0px; }
      .app-shell.terminal-is-open { grid-template-columns:var(--sidebar-width,280px) minmax(0,1fr) var(--terminal-panel-width); }
      .terminal-side-panel { position:relative; }
    }
    @media(min-width:701px) and (max-width:1100px) {
      .app-shell, .app-shell.terminal-is-open { grid-template-columns:var(--sidebar-width,280px) minmax(0,1fr) 0px; }
    }
    @media(min-width:701px) {
      .app-shell.has-docked-conversation[data-sidebar-sliding] {
        grid-template-columns:var(--sidebar-rail-width,52px) minmax(0,1fr) 0px;
      }
    }
    @media(max-width:700px) { .workbench-splitter { display:none; } }
  `;
  document.head.appendChild(style);
  let shell, active, frame = 0, lastChrome = '';
  let previousSidebar, sidebarSlide, sidebarOrigin;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let observedContextPanel;
  const contextResize = new ResizeObserver(() => schedule());
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  function paneLimits(sidebarCollapsed, sidebarPreference = preferred.sidebar) {
    const width = shell?.clientWidth || innerWidth;
    const inspectorDocked = innerWidth >= 960;
    const terminalDocked = innerWidth > 1100;
    const inspectorPresent = inspectorDocked && !!shell.querySelector('.session-layout > .session-inspector');
    const terminalOpen = terminalDocked && shell.classList.contains('terminal-is-open');
    // All open panes share one budget. Reserving the conversation independently
    // for each side pane can otherwise spend that same space twice after zooming.
    const conversationMin = inspectorDocked ? 416 : 320;
    const auxiliaryMin = inspectorPresent && terminalOpen ? 240 : 280;
    const sidebarMax = Math.max(200, Math.min(420, width - conversationMin - (terminalOpen ? auxiliaryMin : 0) - (inspectorPresent ? auxiliaryMin : 0)));
    const expandedSidebarWidth = clamp(sidebarPreference, 200, sidebarMax);
    const railWidth = parseFloat(getComputedStyle(shell).getPropertyValue('--sidebar-rail-width')) || 52;
    const sidebar = sidebarCollapsed ? railWidth : expandedSidebarWidth;
    const terminalMax = Math.max(auxiliaryMin, Math.min(900, width - sidebar - conversationMin - (inspectorPresent ? auxiliaryMin : 0)));
    const terminal = terminalOpen ? clamp(preferred.terminal, auxiliaryMin, terminalMax) : 0;
    const workspaceWidth = inspectorDocked ? 0 : shell.querySelector('.workspace')?.clientWidth || 0;
    return {
      expandedSidebarWidth,
      railWidth,
      expandedConversationWidth: width - expandedSidebarWidth,
      sidebar: sidebarCollapsed ? [sidebar, sidebar] : [200, sidebarMax],
      terminal: terminalDocked ? [auxiliaryMin, terminalMax] : [280, Math.max(280, Math.min(900, width - 40))],
      inspector: inspectorDocked
        ? [auxiliaryMin, Math.max(auxiliaryMin, Math.min(900, width - sidebar - terminal - conversationMin))]
        : [280, Math.max(280, Math.min(900, workspaceWidth - (innerWidth <= 700 ? 0 : 320)))],
    };
  }
  function limits(pane) { return paneLimits(shell.classList.contains('has-collapsed-sidebar'))[pane]; }
  function save() {
    try { localStorage.setItem(key, JSON.stringify(preferred)); } catch {}
    // The native backend can use a different loopback port next launch, so persist outside its origin too.
    window.webkit?.messageHandlers?.lakeChrome?.postMessage({ widths: preferred });
  }
  function finishSidebarSlide() {
    if (!sidebarSlide) return;
    if (sidebarSlide.frame) cancelAnimationFrame(sidebarSlide.frame);
    for (const animation of sidebarSlide.animations) animation.cancel();
    sidebarSlide.shell.removeAttribute('data-sidebar-sliding');
    sidebarSlide = undefined;
  }
  function captureSidebarOrigin() {
    if (!shell?.classList.contains('has-docked-conversation')) return;
    const island = shell.querySelector('.island-conversation');
    const header = island?.querySelector('.workspace-header');
    const divider = island?.querySelector('.island-navigation-divider');
    sidebarOrigin = {
      shell,
      buttons: [...shell.querySelectorAll('.workbench-navigation button')].map(button => [button, button.getBoundingClientRect()]),
      headerInset: header ? header.getBoundingClientRect().left - island.getBoundingClientRect().left : undefined,
      padding: island ? getComputedStyle(island).paddingInlineStart : undefined,
      dividerOpacity: divider ? getComputedStyle(divider).opacity : undefined,
    };
  }
  function slideSidebar({ surface, from, fromIsland, width, expandedWidth, railWidth, collapsed, origin }) {
    const css = getComputedStyle(shell);
    // The rail's fade uses the same timing as the slide. CSSOM serializes
    // transitionDuration in seconds even when the source stylesheet uses ms.
    const railFade = getComputedStyle(shell, '::before');
    const timing = {
      duration: parseFloat(railFade.transitionDuration) * 1000,
      easing: railFade.transitionTimingFunction,
      fill: 'both',
    };
    const island = shell.querySelector('.island-conversation');
    const workspace = shell.querySelector('.workspace');
    const reading = workspace.querySelector('.composer-input') ?? workspace.querySelector('.timeline-list');
    const inset = parseFloat(css.getPropertyValue('--conversation-header-inset')) || 16;
    const navStart = parseFloat(css.getPropertyValue('--workbench-navigation-start')) || 0;
    // The reading column is laid out at the rail width for either direction.
    // Give the island the same final horizontal offset as the composer.
    const readingShift = (width - railWidth) / 2;
    const readingTarget = reading ? reading.getBoundingClientRect().left - shell.getBoundingClientRect().left + readingShift : width + inset;
    const islandTarget = collapsed ? Math.max(navStart, readingTarget) : readingTarget;
    shell.style.setProperty('--workbench-island-navigation-left', `${islandTarget}px`);

    const buttons = (origin?.buttons ?? []).map(([button, before]) => ({ button, before, after: button.getBoundingClientRect() }));
    const padding = island ? getComputedStyle(island).paddingInlineStart : undefined;
    const header = island?.querySelector('.workspace-header');
    const headerInset = header ? header.getBoundingClientRect().left - island.getBoundingClientRect().left : undefined;
    const divider = island?.querySelector('.island-navigation-divider');
    // Hold the old geometry through the commit. Starting in its input task can
    // spend the whole transition before a busy WebView paints the first frame.
    const animations = [];
    const animate = (node, from, to) => {
      const animation = node.animate([from, to], timing);
      animation.pause();
      animation.currentTime = 0;
      animations.push(animation);
    };
    const translate = (node, left, right, top = 0) => {
      if (!node || (Math.abs(left - right) < .1 && Math.abs(top) < .1)) return;
      animate(node, { transform: `translate3d(${left}px,${top}px,0)` }, { transform: `translate3d(${right}px,0,0)` });
    };
    translate(surface, from - railWidth, width - railWidth);
    translate(shell.querySelector('.sidebar-navigation-content'), from - expandedWidth, width - expandedWidth);
    translate(island, fromIsland - islandTarget, 0);
    if (origin?.headerInset !== undefined && headerInset !== undefined) {
      translate(header, origin.headerInset - headerInset, 0);
    }
    for (const node of workspace.querySelectorAll('.timeline-list, .conversation-header-backdrop, .composer, .composer-session-controls')) {
      translate(node, (from - railWidth) / 2, readingShift);
    }
    for (const { button, before, after } of buttons) {
      translate(button, before.left - after.left, 0, before.top - after.top);
    }
    if (island && origin?.padding && padding && origin.padding !== padding) {
      animate(island, { paddingInlineStart: origin.padding }, { paddingInlineStart: padding });
      if (divider) {
        const offset = parseFloat(origin.padding) - parseFloat(padding);
        animate(divider, { transform: `translate3d(${offset}px,0,0)`, opacity: origin.dividerOpacity },
          { transform: 'translate3d(0,0,0)', opacity: getComputedStyle(divider).opacity });
      }
    }
    const buttonPaths = buttons.map(({ before, after }) => {
      const x = Math.min(before.left, after.left), y = Math.min(before.top, after.top);
      return [x, y, Math.max(before.right, after.right) - x, Math.max(before.bottom, after.bottom) - y];
    });
    const slide = sidebarSlide = { shell, width, expandedWidth, animations, buttonPaths, frame: 0 };
    slide.frame = requestAnimationFrame(start => {
      slide.frame = 0;
      for (const animation of animations) animation.startTime = start;
    });
    animations[0].onfinish = () => {
      if (sidebarSlide !== slide) return;
      finishSidebarSlide();
      window.dispatchEvent(new Event('lake-workbench-layout'));
    };
  }
  function apply() {
    if (!shell) return;
    const collapsed = shell.classList.contains('has-collapsed-sidebar');
    const docked = shell.classList.contains('has-docked-conversation') && innerWidth > 700;
    const sidebarPreference = active?.pane === 'sidebar' ? sidebarDragWidth(active, active.clientX) : preferred.sidebar;
    const target = paneLimits(collapsed, sidebarPreference);
    const width = clamp(sidebarPreference, ...target.sidebar);
    const surface = docked && shell.querySelector('.workbench-conversation-surface');
    const canSlide = surface && previousSidebar?.shell === shell && previousSidebar.docked &&
      !active && !document.hidden && !reducedMotion?.matches && typeof shell.animate === 'function';
    const toggled = canSlide && previousSidebar.collapsed !== collapsed;
    const origin = toggled && sidebarOrigin?.shell === shell ? sidebarOrigin : undefined;
    if (previousSidebar?.shell !== shell || previousSidebar.collapsed !== collapsed) sidebarOrigin = undefined;
    const shellLeft = toggled ? shell.getBoundingClientRect().left : 0;
    const from = toggled ? surface.getBoundingClientRect().left - shellLeft : width;
    // Capture the painted position before cancelling an interrupted slide.
    const island = toggled ? shell.querySelector('.island-conversation') : null;
    const fromIsland = island ? island.getBoundingClientRect().left - shellLeft : from;
    const startSlide = Math.abs(from - width) >= .5;
    if (sidebarSlide && (!canSlide || toggled || sidebarSlide.width !== width || sidebarSlide.expandedWidth !== target.expandedSidebarWidth)) finishSidebarSlide();
    previousSidebar = { shell, docked, collapsed };
    if (startSlide) shell.setAttribute('data-sidebar-sliding', '');
    shell.style.setProperty('--sidebar-expanded-width', `${target.expandedSidebarWidth}px`);
    shell.style.setProperty('--expanded-conversation-width', `${target.expandedConversationWidth}px`);
    shell.style.setProperty('--inspector-requested-width', `${preferred.inspector}px`);
    for (const pane of ['sidebar', 'terminal', 'inspector']) {
      const [min, max] = target[pane];
      const paneWidth = pane === 'sidebar' ? width : clamp(preferred[pane], min, max);
      shell.style.setProperty(pane === 'sidebar' ? '--sidebar-width' : pane === 'terminal' ? '--terminal-panel-width' : '--inspector-preferred-width', `${paneWidth}px`);
      const handle = shell.querySelector(`.workbench-splitter-${pane}`);
      if (handle) for (const [name, value] of [['valuemin', min], ['valuemax', max], ['valuenow', paneWidth]]) handle.setAttribute(`aria-${name}`, String(value));
    }
    if (startSlide) slideSidebar({ surface, from, fromIsland, width, expandedWidth: target.expandedSidebarWidth, railWidth: target.railWidth, collapsed, origin });
  }
  function sidebarDragWidth(drag, x) {
    return drag.width + x - drag.x;
  }
  function retainStyles(node, names) {
    const original = names.map(name => [name, node.style.getPropertyValue(name), node.style.getPropertyPriority(name)]);
    return () => {
      for (const [name, value, priority] of original) {
        if (value) node.style.setProperty(name, value, priority);
        else node.style.removeProperty(name);
      }
    };
  }
  function alignVisibleUserMessages(conversation, initialWidth) {
    const selector = '.ai-role-user,.timeline-item.message-user';
    const overscan = 64;
    const visible = new Map();
    let width = initialWidth;
    const align = (node, bubble) => {
      node.style.setProperty('translate', `${width - initialWidth}px`);
      const limit = Math.min(bubble.width, width * .85);
      if (bubble.limit === limit) return;
      bubble.limit = limit;
      if (limit < bubble.width) node.style.setProperty('max-width', `${limit}px`);
      else bubble.restoreWidth();
    };
    const show = (node, rect) => {
      if (visible.has(node)) return;
      const width = node.matches('.ai-role-user') ? rect.width : 0;
      const bubble = {
        width, limit: width,
        restorePosition: retainStyles(node, ['translate']),
        restoreWidth: retainStyles(node, ['max-width']),
      };
      visible.set(node, bubble);
      align(node, bubble);
    };
    const hide = node => {
      const bubble = visible.get(node);
      if (!bubble) return;
      bubble.restorePosition();
      bubble.restoreWidth();
      visible.delete(node);
    };
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) show(entry.target, entry.boundingClientRect);
        else hide(entry.target);
      }
    }, { root: conversation, rootMargin: `${overscan}px 0px` });
    const bounds = conversation.getBoundingClientRect();
    const messages = [...conversation.querySelectorAll(selector)].map(node => [node, node.getBoundingClientRect()]);
    for (const [node, rect] of messages) {
      observer.observe(node);
      if (rect.bottom > bounds.top - overscan && rect.top < bounds.bottom + overscan) show(node, rect);
    }
    const changes = new MutationObserver(records => {
      for (const record of records) {
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          if (node.nodeType !== 1) continue;
          const bubbles = [...node.querySelectorAll(selector)];
          if (node.matches(selector)) bubbles.push(node);
          for (const bubble of bubbles) {
            if (conversation.contains(bubble)) observer.observe(bubble);
            else {
              observer.unobserve(bubble);
              hide(bubble);
            }
          }
        }
      }
    });
    changes.observe(conversation, { childList:true, subtree:true });
    return {
      resize(nextWidth) {
        if (width === nextWidth) return;
        width = nextWidth;
        for (const [node, bubble] of visible) align(node, bubble);
      },
      restore() {
        changes.disconnect();
        observer.disconnect();
        observer.takeRecords();
        for (const node of visible.keys()) hide(node);
      },
    };
  }
  function layerSidebarResize(drag) {
    if (!shell.classList.contains('has-docked-conversation') || shell.querySelector('.session-layout > .session-inspector')) return;
    const owner = shell;
    const sidebar = owner.querySelector('.sidebar');
    const surface = owner.querySelector('.workbench-conversation-surface');
    const workspace = owner.querySelector('.workspace');
    const composer = workspace?.querySelector('.composer-dock');
    const conversation = workspace?.querySelector('.conversation');
    if (!sidebar || !surface || !composer || !conversation) return;

    const [min, max] = limits('sidebar');
    const viewport = composer.getBoundingClientRect().width;
    if (!viewport) return;
    const gutter = parseFloat(getComputedStyle(composer).paddingInlineStart) || 0;
    const extra = drag.width - min;
    const scrollWidth = conversation.getBoundingClientRect().width + extra;
    const start = width => Math.max(gutter, (width - 960) / 2);
    const readingWidth = width => Math.min(960, width - gutter * 2);
    const initialStart = start(viewport);
    const navigation = owner.querySelector('.workbench-navigation');
    const navigationInIsland = !!navigation && (owner.classList.contains('has-workbench-conversation') || owner.classList.contains('has-docked-conversation'));
    const panes = [surface, workspace, drag.handle, navigationInIsland ? null : navigation].filter(Boolean);
    const header = [owner.querySelector('.lake-workbench-islands'), navigationInIsland ? navigation : null].filter(Boolean);
    const reading = workspace.querySelectorAll('.timeline-list,.conversation-header-backdrop');
    const restore = [
      retainStyles(sidebar, ['inline-size']),
      retainStyles(surface, ['inset-inline-end']),
      retainStyles(composer, ['--sidebar-resize-viewport']),
      retainStyles(conversation, ['inline-size']),
      ...[...panes, ...header, ...reading].filter(Boolean).map(node => retainStyles(node, ['transform'])),
    ];
    const userMessages = alignVisibleUserMessages(conversation, readingWidth(viewport));
    // Lay out the scroll view once. Its largest possible clip fits both
    // directions while the real rounded frame moves across it.
    surface.style.setProperty('inset-inline-end', `${-extra}px`);
    conversation.style.setProperty('inline-size', `${scrollWidth}px`);
    owner.setAttribute('data-sidebar-resize-layer', '');
    let lastWidth;
    let lastReadingOffset;
    const translate = (node, x) => { if (node) node.style.setProperty('transform', `translate3d(${x}px,0,0)`); };
    const update = x => {
      const width = clamp(sidebarDragWidth(drag, x), min, max);
      if (width === lastWidth) return;
      lastWidth = width;
      const offset = width - drag.width;
      const room = viewport - offset;
      const readingOffset = start(room) - initialStart;
      sidebar.style.setProperty('inline-size', `${width}px`);
      composer.style.setProperty('--sidebar-resize-viewport', `${room}px`);
      for (const pane of panes) translate(pane, offset);
      if (lastReadingOffset !== readingOffset) {
        lastReadingOffset = readingOffset;
        for (const node of reading) translate(node, readingOffset);
      }
      for (const node of header) translate(node, offset + readingOffset);
      userMessages.resize(readingWidth(room));
      drag.handle.setAttribute('aria-valuenow', String(width));
    };
    update(drag.x);
    return {
      workspace, conversation, windowWidth: innerWidth, windowHeight: innerHeight, update,
      restore() {
        owner.removeAttribute('data-sidebar-resize-layer');
        for (const reset of restore) reset();
        userMessages.restore();
      },
    };
  }
  function holdReadingLayout(box) {
    const timeline = box?.querySelector(':scope > .timeline-list');
    const width = timeline?.getBoundingClientRect().width;
    if (!width) return;
    // Stable inherited geometry lets WebKit reuse the transcript layout as
    // the grid and its chrome change size around the scroll view.
    const properties = [
      '--sidebar-width', '--sidebar-expanded-width', '--expanded-conversation-width',
      '--terminal-panel-width', '--inspector-preferred-width', '--inspector-width',
      '--pane-rail-bottom', '--workbench-island-navigation-left', '--workbench-island-navigation-top',
      '--docked-reading-viewport', '--session-content-width', '--session-content-start', '--session-gutter',
    ];
    const css = getComputedStyle(box);
    const values = properties.map(name => [name, css.getPropertyValue(name) || 'initial']);
    values.push(['--sidebar-resize-reading-width', `${width}px`]);
    const restore = retainStyles(box, values.map(([name]) => name));
    for (const [name, value] of values) box.style.setProperty(name, value);
    box.setAttribute('data-sidebar-resizing', '');
    return () => {
      box.removeAttribute('data-sidebar-resizing');
      restore();
    };
  }
  function clearDrag() {
    const { handle, pointer, previewFrame, restoreReadingLayout, sidebarLayer } = active;
    active = null;
    if (previewFrame) cancelAnimationFrame(previewFrame);
    sidebarLayer?.restore();
    restoreReadingLayout?.();
    handle.classList.remove('is-dragging');
    document.documentElement.classList.remove('workbench-resizing');
    if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
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
      if (event.button !== 0 || active) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const width = pane === 'sidebar' ? Number(handle.getAttribute('aria-valuenow'))
        : shell.querySelector(pane === 'terminal' ? '.terminal-side-panel' : '.session-inspector').getBoundingClientRect().width;
      active = { pane, handle, x: event.clientX, clientX: event.clientX, width, pointer: event.pointerId };
      if (pane === 'sidebar') {
        active.sidebarLayer = layerSidebarResize(active);
        if (!active.sidebarLayer) active.restoreReadingLayout = holdReadingLayout(shell.querySelector('.conversation'));
      }
      handle.classList.add('is-dragging');
      document.documentElement.classList.add('workbench-resizing');
    });
    handle.addEventListener('pointermove', event => {
      const drag = active;
      if (drag?.handle !== handle || drag.pointer !== event.pointerId) return;
      if (pane === 'sidebar') {
        drag.clientX = event.clientX;
        if (!drag.previewFrame) drag.previewFrame = requestAnimationFrame(() => {
          drag.previewFrame = 0;
          if (drag.sidebarLayer) drag.sidebarLayer.update(drag.clientX);
          else apply();
        });
        return;
      }
      const [min, max] = limits(pane);
      if (min === max) return;
      preferred[pane] = clamp(drag.width + drag.x - event.clientX, min, max);
      apply();
      schedule();
    });
    const finish = event => {
      if (active?.handle !== handle || active.pointer !== event.pointerId) return;
      if (pane !== 'sidebar') {
        save();
        clearDrag();
        return;
      }
      let committed = false;
      if (event.type === 'pointerup' && innerWidth > 700 && handle.isConnected) {
        const [min, max] = limits(pane);
        const width = clamp(sidebarDragWidth(active, event.clientX), min, max);
        if (min !== max && width !== clamp(preferred.sidebar, min, max)) {
          window.dispatchEvent(new Event('lake-workbench-sidebar-will-resize'));
          preferred.sidebar = width;
          committed = true;
        }
      }
      clearDrag();
      window.dispatchEvent(new Event('lake-workbench-layout'));
      if (committed) save();
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish);
    handle.addEventListener('dblclick', () => { preferred[pane] = pane === 'sidebar' ? 280 : pane === 'terminal' ? 400 : 382; apply(); save(); schedule(); });
    handle.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (active?.sidebarLayer) return;
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
    const sidebarControls = [...shell.querySelectorAll('.sidebar-brand-row :is(button, a, input, select, textarea, [role="button"], [role="combobox"])')]
      .filter(element => element.getBoundingClientRect().width > 0 && !element.closest('[aria-hidden="true"]') && getComputedStyle(element).visibility !== 'hidden');
    const excluded = [...shell.querySelectorAll('.workbench-splitter, .workbench-navigation button'), ...sidebarControls, ...headers.flatMap(header => [...header.querySelectorAll('button, a, input, select, textarea, [role="button"]')])].map(rect);
    if (sidebarSlide?.shell === shell) excluded.push(...sidebarSlide.buttonPaths);
    for (const element of document.querySelectorAll('.conversation-directory-trigger, .modal-scrim, dialog[open], [role="dialog"], [role="menu"], [role="listbox"]')) excluded.push(rect(element));
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
    const header = (shell.querySelector('.island-conversation') ?? workspace.querySelector('.workspace-header'))?.getBoundingClientRect();
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
    const nextShell = document.querySelector('.app-shell');
    if (active && (!active.handle.isConnected || active.pane === 'sidebar' &&
      (nextShell !== shell || document.hidden || innerWidth <= 700 || nextShell.classList.contains('has-collapsed-sidebar')))) clearDrag();
    const layer = active?.sidebarLayer;
    if (layer) {
      if (innerWidth === layer.windowWidth && innerHeight === layer.windowHeight &&
        layer.workspace.isConnected && layer.conversation.isConnected && nextShell.classList.contains('has-docked-conversation') &&
        !nextShell.querySelector('.session-layout > .session-inspector')) return;
      clearDrag();
    }
    shell = nextShell;
    if (!shell) return;
    addHandle(shell, 'sidebar');
    const terminal = shell.querySelector('.terminal-side-panel');
    if (terminal) addHandle(terminal, 'terminal');
    const inspector = shell.querySelector('.session-layout > .session-inspector.is-open');
    if (inspector) addHandle(inspector, 'inspector');
    apply(); syncChrome(); placeContextPanel();
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(sync); }
  new MutationObserver(schedule).observe(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:['class'] });
  new MutationObserver(schedule).observe(document.documentElement, { attributes:true, attributeFilter:['data-theme'] });
  window.addEventListener('resize', schedule);
  document.addEventListener('visibilitychange', schedule);
  reducedMotion?.addEventListener('change', schedule);
  // React pane toggles must settle widths in the same commit, before paint.
  window.addEventListener('lake-workbench-sidebar-toggle', captureSidebarOrigin);
  window.addEventListener('lake-workbench-layout', sync);
  document.addEventListener('scroll', () => { if (!sidebarSlide) schedule(); }, true);
  window.addEventListener('lake-chrome-resize', schedule);
  document.addEventListener('transitionend', event => { if (event.target.matches('.app-shell, .terminal-side-panel, .workbench-navigation')) schedule(); });
  schedule();
})();
