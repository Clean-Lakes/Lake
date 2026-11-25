import {useLayoutEffect, useRef, useState, type ReactNode, type RefObject} from 'react';
import {Glyph} from './Icons';
import {navigateSettingsTabs, settingsTabStops, trapSettingsTab} from './settingsFocus';
import {consoleCategories, consolePanelId, consoleTabId, type ConsolePage} from './workspaceConsoleTabs';
import './workspaceConsole.css';

const reducedMotion = '(prefers-reduced-motion: reduce)';
// The Bento Card spring at 600 ms with 0.2 bounce, sampled every 30 ms.
const selectionSpring = 'linear(0,.0794,.2486,.4375,.6093,.7484,.8518,.9231,.9688,.9954,1.0091,1.0144,1.015,1.0131,1.0104,1.0076,1.0051,1.0032,1.0018,1.0009,1)';

function cancelSelectionMotion(background: HTMLElement, mark: HTMLElement) {
  for (const layer of [background, mark]) layer.getAnimations?.().forEach(animation => animation.cancel());
}

function selectionTransform(top: number, scale = 1) {
  return 'translate3d(0,' + top + 'px,0) scaleY(' + scale + ')';
}

function alignSelection(list: HTMLElement, background: HTMLElement, mark: HTMLElement, reveal = false) {
  const row = list.querySelector<HTMLButtonElement>('[aria-selected="true"]:not([hidden])');
  if (!row) {
    list.removeAttribute('data-selection-visible');
    cancelSelectionMotion(background, mark);
    return;
  }
  const bounds = row.getBoundingClientRect();
  const scroll = list.scrollTop;
  const origin = list.getBoundingClientRect().top + list.clientTop - scroll;
  const top = Math.round((bounds.top - origin) * 1000) / 1000;
  const height = Math.round(bounds.height * 1000) / 1000;
  const visible = list.hasAttribute('data-selection-visible');
  const atTarget = visible && background.style.getPropertyValue('--console-selection-top') === top + 'px' &&
    background.style.height === height + 'px';
  // Read the painted position before cancelling an interrupted slide or scrolling.
  const moving = reveal && !atTarget && visible && background.dataset.tab !== row.id &&
    typeof background.animate === 'function' && !document.hidden && !window.matchMedia(reducedMotion).matches;
  const from = moving ? background.getBoundingClientRect() : null;

  if (reveal) {
    if (top < scroll) list.scrollTop = top;
    else if (top + height > scroll + list.clientHeight) list.scrollTop = top + height - list.clientHeight;
  }
  background.dataset.tab = row.id;
  if (atTarget) return;

  cancelSelectionMotion(background, mark);
  background.style.setProperty('--console-selection-top', top + 'px');
  background.style.height = height + 'px';
  mark.style.setProperty('--console-selection-center', top + height / 2 + 'px');
  list.setAttribute('data-selection-visible', '');
  if (!from || !height) return;

  const fromTop = from.top - origin;
  const timing: KeyframeAnimationOptions = {
    duration: 600, fill: 'backwards',
    easing: CSS.supports('animation-timing-function', selectionSpring) ? selectionSpring : 'cubic-bezier(.2,.85,.3,1)',
  };
  // Scale only the moving background. The blue mark keeps its physical height.
  background.animate([
    {transform: selectionTransform(fromTop, from.height / height)},
    {transform: selectionTransform(top)},
  ], timing);
  mark.animate([
    {transform: selectionTransform(fromTop + from.height / 2)},
    {transform: selectionTransform(top + height / 2)},
  ], timing);
}

export function WorkspaceConsole({dialogRef, open, page, typescriptBackend, busy, overlay, notice, onClose, onPage, children}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  open: boolean;
  page: ConsolePage;
  typescriptBackend: boolean;
  busy: boolean;
  overlay?: ReactNode;
  notice?: ReactNode;
  onClose: () => void;
  onPage: (page: ConsolePage) => void;
  children: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const selectionBackground = useRef<HTMLSpanElement>(null);
  const selectionMark = useRef<HTMLSpanElement>(null);
  const overlayRoot = useRef<HTMLDivElement>(null);
  const lastFrameFocus = useRef<HTMLElement | null>(null);
  const hadOverlay = useRef(false);
  const groups = consoleCategories(typescriptBackend, '');
  const matching = new Set(consoleCategories(typescriptBackend, query).flatMap(group => group.items.map(item => item.key)));
  const first = matching.values().next().value;
  const tabbable = matching.has(page) ? page : first;
  const hasOverlay = Boolean(overlay);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setQuery('');
      dialog.showModal();
      search.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [dialogRef, open]);
  useLayoutEffect(() => {
    const list = tabs.current;
    const background = selectionBackground.current;
    const mark = selectionMark.current;
    if (!list || !background || !mark) return;
    if (!open) {
      list.removeAttribute('data-selection-visible');
      cancelSelectionMotion(background, mark);
      return;
    }
    alignSelection(list, background, mark, !query);
  }, [open, page, query, typescriptBackend]);
  useLayoutEffect(() => {
    const list = tabs.current;
    const background = selectionBackground.current;
    const mark = selectionMark.current;
    if (!open || !list || !background || !mark) return;
    const resize = new ResizeObserver(() => alignSelection(list, background, mark));
    resize.observe(list);
    list.querySelectorAll('.workspace-console-group').forEach(group => resize.observe(group));
    const motion = window.matchMedia(reducedMotion);
    const settle = () => { if (motion.matches || document.hidden) cancelSelectionMotion(background, mark); };
    motion.addEventListener('change', settle);
    document.addEventListener('visibilitychange', settle);
    return () => {
      resize.disconnect();
      motion.removeEventListener('change', settle);
      document.removeEventListener('visibilitychange', settle);
      cancelSelectionMotion(background, mark);
    };
  }, [open]);
  useLayoutEffect(() => {
    const layer = overlayRoot.current;
    if (open && layer && !layer.contains(document.activeElement)) settingsTabStops(layer)[0]?.focus();
    if (open && !hasOverlay && hadOverlay.current) {
      const previous = lastFrameFocus.current;
      (previous?.isConnected ? previous : search.current)?.focus({preventScroll: true});
    }
    hadOverlay.current = hasOverlay;
  }, [open, hasOverlay]);

  function choose(next: ConsolePage) {
    if (busy) return;
    if (next !== page) onPage(next);
    if (query) {
      setQuery('');
      search.current?.focus();
    }
  }

  return <dialog ref={dialogRef} className="workspace-console" id="workspace-console" role="dialog" aria-label="控制台"
    onCancel={event => {
      event.preventDefault();
      // React's cancel event also bubbles from the provider's discard dialog.
      if (event.target === event.currentTarget && !hasOverlay) onClose();
    }}
    onClick={event => {
      if (event.target === event.currentTarget && !hasOverlay) onClose();
    }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      const target = event.target as HTMLElement;
      if (hasOverlay) {
        trapSettingsTab(event, overlayRoot.current);
        return;
      }
      if (target.closest('dialog,[role="dialog"]') !== dialogRef.current) return;
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey &&
          !target.closest('input,textarea,[contenteditable]')) {
        event.preventDefault();
        search.current?.focus();
      }
      trapSettingsTab(event, dialogRef.current);
    }}>
    <div className="workspace-console-frame" inert={hasOverlay} onFocusCapture={event => {
      lastFrameFocus.current = event.target as HTMLElement;
    }}>
      <nav className="workspace-console-nav" aria-label="控制台分类">
        <label className="workspace-console-search">
          <Glyph name="search" size={17}/>
          <input ref={search} type="search" aria-label="搜索控制台" placeholder="搜索" autoComplete="off" value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'Escape' && query) {
                event.preventDefault();
                setQuery('');
              }
              if (event.key === 'ArrowDown' && first && !busy) {
                event.preventDefault();
                document.getElementById(consoleTabId(first))?.focus();
              }
              if (event.key === 'Enter' && first && query.trim() && matching.size === 1) {
                event.preventDefault();
                choose(first);
              }
            }}/>
          <kbd aria-hidden="true">/</kbd>
        </label>
        <div ref={tabs} className="workspace-console-categories" role="tablist" aria-label="分类" aria-orientation="vertical"
          onKeyDown={event => navigateSettingsTabs(event, event.currentTarget)}>
          <span ref={selectionBackground} className="workspace-console-selection" aria-hidden="true"/>
          <span ref={selectionMark} className="workspace-console-selection-mark" aria-hidden="true"/>
          {groups.map(group => <div key={group.label} className="workspace-console-group" role="group" aria-label={group.label}
            hidden={!group.items.some(item => matching.has(item.key))}>
            {group.showLabel && <span className="workspace-console-group-label" aria-hidden="true">{group.label}</span>}
            {group.items.map(item => <button type="button" key={item.key} id={consoleTabId(item.key)} role="tab"
              className="workspace-console-tab" aria-selected={page === item.key}
              aria-controls={page === item.key ? consolePanelId(item.key) : undefined}
              tabIndex={tabbable === item.key ? 0 : -1} disabled={busy} hidden={!matching.has(item.key)}
              onClick={() => choose(item.key)} title={item.label}>
              <Glyph name={item.icon} size={16}/><span>{item.label}</span>
            </button>)}
          </div>)}
          {!first && <p className="workspace-console-empty" role="status">没有匹配的分类</p>}
        </div>
      </nav>
      <div className="workspace-console-content">
        <button type="button" className="icon-button workspace-console-close" title="关闭控制台"
          aria-label="关闭控制台" onClick={onClose}><Glyph name="close" size={18}/></button>
        {children}
      </div>
    </div>
    {hasOverlay && <div ref={overlayRoot} className="workspace-console-overlays">{overlay}</div>}
    {notice}
  </dialog>;
}
