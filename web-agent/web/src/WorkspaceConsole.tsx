import {useLayoutEffect, useRef, useState, type ReactNode, type RefObject} from 'react';
import {Glyph} from './Icons';
import {navigateSettingsTabs, settingsTabStops, trapSettingsTab} from './settingsFocus';
import {consoleCategories, consolePanelId, consoleTabId, type ConsolePage} from './workspaceConsoleTabs';
import './workspaceConsole.css';

const reducedMotion = '(prefers-reduced-motion: reduce)';
// The Bento Card spring at 600 ms with 0.2 bounce, sampled every 30 ms.
const selectionSpring = 'linear(0,.0794,.2486,.4375,.6093,.7484,.8518,.9231,.9688,.9954,1.0091,1.0144,1.015,1.0131,1.0104,1.0076,1.0051,1.0032,1.0018,1.0009,1)';

function cancelSelectionMotion(background: HTMLElement) {
  background.getAnimations?.().forEach(animation => animation.cancel());
}

function selectionTransform(top: number, scale = 1) {
  return 'translate3d(0,' + top + 'px,0) scaleY(' + scale + ')';
}

function alignSelection(list: HTMLElement, background: HTMLElement, reveal = false) {
  const row = list.querySelector<HTMLButtonElement>('[aria-selected="true"]:not([hidden])');
  if (!row) {
    list.removeAttribute('data-selection-visible');
    cancelSelectionMotion(background);
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

  cancelSelectionMotion(background);
  background.style.setProperty('--console-selection-top', top + 'px');
  background.style.height = height + 'px';
  list.setAttribute('data-selection-visible', '');
  if (!from || !height) return;

  const fromTop = from.top - origin;
  const timing: KeyframeAnimationOptions = {
    duration: 600, fill: 'backwards',
    easing: CSS.supports('animation-timing-function', selectionSpring) ? selectionSpring : 'cubic-bezier(.2,.85,.3,1)',
  };
  background.animate([
    {transform: selectionTransform(fromTop, from.height / height)},
    {transform: selectionTransform(top)},
  ], timing);
}

function consoleEntranceAnimations(dialog: HTMLDialogElement) {
  return dialog.getAnimations({subtree: true}).filter(animation => 'animationName' in animation &&
    (animation.animationName === 'workspace-console-frame-in' || animation.animationName === 'workspace-console-backdrop-in'));
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
  const [present, setPresent] = useState(open);
  const visible = open || present;
  const closing = present && !open;
  const currentView = {page, busy, children};
  const lastOpenView = useRef(currentView);
  const displayed = closing ? lastOpenView.current : currentView;
  const exitAnimations = useRef<Animation[]>([]);
  const search = useRef<HTMLInputElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const selectionBackground = useRef<HTMLSpanElement>(null);
  const overlayRoot = useRef<HTMLDivElement>(null);
  const lastFrameFocus = useRef<HTMLElement | null>(null);
  const hadOverlay = useRef(false);
  const groups = consoleCategories(typescriptBackend, '');
  const matching = new Set(consoleCategories(typescriptBackend, query).flatMap(group => group.items.map(item => item.key)));
  const first = matching.values().next().value;
  const tabbable = matching.has(displayed.page) ? displayed.page : first;
  const hasOverlay = open && Boolean(overlay);

  // Navigation can remove the page before the native dialog finishes reversing.
  useLayoutEffect(() => { if (open) lastOpenView.current = currentView; });
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) {
        setQuery('');
        dialog.showModal();
        setPresent(true);
      } else {
        for (const animation of exitAnimations.current) {
          if (animation.playState !== 'idle') animation.reverse();
        }
      }
      exitAnimations.current = [];
      search.current?.focus();
      return;
    }
    if (!dialog.open) return;

    const finish = () => {
      exitAnimations.current = [];
      dialog.close();
      setPresent(false);
    };
    const motion = window.matchMedia(reducedMotion);
    const animations = document.hidden || motion.matches ? [] : consoleEntranceAnimations(dialog);
    // When no entrance frame has painted, there is nothing to play back.
    if (!animations.some(animation => Number(animation.currentTime) > 0)) return finish();
    exitAnimations.current = animations;
    for (const animation of animations) animation.reverse();

    const controller = new AbortController();
    const settle = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      finish();
    };
    const skipMotion = () => { if (document.hidden || motion.matches) settle(); };
    motion.addEventListener('change', skipMotion, {signal: controller.signal});
    document.addEventListener('visibilitychange', skipMotion, {signal: controller.signal});
    void Promise.allSettled(animations.map(animation => animation.finished)).then(settle);
    return () => controller.abort();
  }, [dialogRef, open]);
  useLayoutEffect(() => {
    const list = tabs.current;
    const background = selectionBackground.current;
    if (!list || !background) return;
    if (!visible) {
      list.removeAttribute('data-selection-visible');
      cancelSelectionMotion(background);
      return;
    }
    alignSelection(list, background, !query);
  }, [visible, displayed.page, query, typescriptBackend]);
  useLayoutEffect(() => {
    const list = tabs.current;
    const background = selectionBackground.current;
    if (!visible || !list || !background) return;
    const resize = new ResizeObserver(() => alignSelection(list, background));
    resize.observe(list);
    list.querySelectorAll('.workspace-console-group').forEach(group => resize.observe(group));
    const motion = window.matchMedia(reducedMotion);
    const settle = () => { if (motion.matches || document.hidden) cancelSelectionMotion(background); };
    motion.addEventListener('change', settle);
    document.addEventListener('visibilitychange', settle);
    return () => {
      resize.disconnect();
      motion.removeEventListener('change', settle);
      document.removeEventListener('visibilitychange', settle);
      cancelSelectionMotion(background);
    };
  }, [visible]);
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

  function requestClose() {
    if (open && !hasOverlay) onClose();
  }

  return <dialog ref={dialogRef} className="workspace-console" id="workspace-console" role="dialog" aria-label="控制台"
    onCancel={event => {
      event.preventDefault();
      // React's cancel event also bubbles from the provider's discard dialog.
      if (event.target === event.currentTarget) requestClose();
    }}
    onClick={event => {
      if (event.target === event.currentTarget) requestClose();
    }}
    onKeyDown={event => {
      if (!open || event.nativeEvent.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
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
    <div className="workspace-console-frame" inert={hasOverlay || closing} onFocusCapture={event => {
      lastFrameFocus.current = event.target as HTMLElement;
    }}>
      <nav className="workspace-console-nav" aria-label="控制台分类">
        <label className="workspace-console-search">
          <Glyph name="search" size={17}/>
          <input ref={search} type="search" aria-label="搜索控制台" aria-keyshortcuts="/" title="搜索控制台（/）"
            placeholder="搜索" autoComplete="off" value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'Escape') {
                event.preventDefault();
                if (query) setQuery('');
                else requestClose();
                return;
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
        </label>
        <div ref={tabs} className="workspace-console-categories" role="tablist" aria-label="分类" aria-orientation="vertical"
          onKeyDown={event => navigateSettingsTabs(event, event.currentTarget)}>
          <span ref={selectionBackground} className="workspace-console-selection" aria-hidden="true"/>
          {groups.map(group => <div key={group.label} className="workspace-console-group" role="group" aria-label={group.label}
            hidden={!group.items.some(item => matching.has(item.key))}>
            {group.showLabel && <span className="workspace-console-group-label" aria-hidden="true">{group.label}</span>}
            {group.items.map(item => <button type="button" key={item.key} id={consoleTabId(item.key)} role="tab"
              className="workspace-console-tab" aria-selected={displayed.page === item.key}
              aria-controls={displayed.page === item.key ? consolePanelId(item.key) : undefined}
              tabIndex={tabbable === item.key ? 0 : -1} disabled={displayed.busy} hidden={!matching.has(item.key)}
              onClick={() => choose(item.key)} title={item.label}>
              <Glyph name={item.icon} size={16}/><span>{item.label}</span>
            </button>)}
          </div>)}
          {!first && <p className="workspace-console-empty" role="status">没有匹配的分类</p>}
        </div>
      </nav>
      <div className="workspace-console-content">
        <button type="button" className="icon-button workspace-console-close" title="关闭控制台"
          aria-label="关闭控制台" onClick={requestClose}><Glyph name="close" size={18}/></button>
        {displayed.children}
      </div>
    </div>
    {hasOverlay && <div ref={overlayRoot} className="workspace-console-overlays">{overlay}</div>}
    {notice}
  </dialog>;
}
