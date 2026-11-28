import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {menuMotionDurations, menuMotionFrames} from '../src/useMenuMotion';
import {
  alignSelectionIndicator,
  selectionSpring,
  selectionSpringDuration,
  selectionSpringTiming,
} from '../src/selectionMotion';
import {TabSelectionIndicator} from '../src/TabSelectionIndicator';
import {AppSelect} from '../src/AppSelect';
import {NavigationMenu} from '../src/NavigationDelete';
import {ConversationDirectory} from '../src/ConversationDirectory';
import {PermissionSettings} from '../src/PermissionSettings';

const css = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.css') ? {format: 'module', source: 'export {};', shortCircuit: true} : nextLoad(url, context);
  },
});
const {MCPSettings} = await import('../src/MCPSettings');
const {CodexModelConfiguration} = await import('../src/CodexModelConfiguration');
const {SidebarWorkspaceNavigation} = await import('../src/SidebarWorkspaceNavigation');
const {PilotWorkspace} = await import('../src/PilotWorkspace');
const {WorkspaceConsole} = await import('../src/WorkspaceConsole');
css.deregister();

function fakeElement(rect: {left: number; top: number; width: number; height: number}, id = '') {
  const attrs = new Map<string, string>();
  const props = new Map<string, string>();
  const dataset: Record<string, string | undefined> = {};
  const animations: Array<{cancel: () => void; keyframes: Keyframe[]; options: KeyframeAnimationOptions}> = [];
  const style = new Proxy(
    {
      width: '',
      height: '',
      getPropertyValue(name: string) {
        return props.get(name) ?? '';
      },
      setProperty(name: string, value: string) {
        props.set(name, value);
      },
    },
    {},
  );
  let currentRect = {...rect};
  const node = {
    id,
    clientLeft: 0,
    clientTop: 0,
    scrollLeft: 0,
    scrollTop: 0,
    clientHeight: 400,
    dataset,
    style,
    animateCalls: animations,
    setRect(next: {left: number; top: number; width: number; height: number}) {
      currentRect = {...next};
    },
    getBoundingClientRect() {
      return {
        ...currentRect,
        right: currentRect.left + currentRect.width,
        bottom: currentRect.top + currentRect.height,
        x: currentRect.left,
        y: currentRect.top,
        toJSON() {
          return this;
        },
      };
    },
    hasAttribute(name: string) {
      return attrs.has(name);
    },
    setAttribute(name: string, value: string) {
      attrs.set(name, value);
    },
    removeAttribute(name: string) {
      attrs.delete(name);
    },
    getAttribute(name: string) {
      return attrs.get(name) ?? null;
    },
    getAnimations() {
      return animations;
    },
    animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const entry = {
        keyframes,
        options,
        cancel() {
          const index = animations.indexOf(entry);
          if (index >= 0) animations.splice(index, 1);
        },
      };
      animations.push(entry);
      return entry;
    },
  };
  return node;
}

test('menu motion constants match ProjectSwitcher popup expand/retract curves', () => {
  assert.deepEqual(menuMotionDurations, {enter: 170, exit: 125});
  assert.deepEqual(menuMotionFrames, {
    collapsed: {opacity: 0, transform: 'scale(.92,.76)'},
    expanded: {opacity: 1, transform: 'none'},
  });
});

test('AppSelect defaults to popupMotion=true while ComposerModelSelect keeps its native popover override', () => {
  const appSelectSource = readFileSync(new URL('../src/AppSelect.tsx', import.meta.url), 'utf8');
  const composerModelSource = readFileSync(new URL('../src/ComposerModelSelect.tsx', import.meta.url), 'utf8');
  assert.match(appSelectSource, /popupMotion=true/);
  assert.match(composerModelSource, /popupMotion=\{!onProviderMenu\}/);
});

test('selection spring constants match the 600ms Bento spring and wire into WorkspaceConsole and TabSelectionIndicator', () => {
  assert.equal(selectionSpringDuration, 600);
  assert.ok(selectionSpring.startsWith('linear(0,.0794,.2486'));
  const timing = selectionSpringTiming();
  assert.equal(timing.duration, 600);
  assert.equal(timing.fill, 'backwards');

  const workspaceConsoleSource = readFileSync(new URL('../src/WorkspaceConsole.tsx', import.meta.url), 'utf8');
  const tabIndicatorSource = readFileSync(new URL('../src/TabSelectionIndicator.tsx', import.meta.url), 'utf8');
  assert.match(workspaceConsoleSource, /alignSelectionIndicator\(/);
  assert.match(tabIndicatorSource, /alignSelectionIndicator\(/);
});

test('alignSelectionIndicator places silently first, springs across target changes, and skips animation on resize', () => {
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevCSS = globalThis.CSS;
  (globalThis as unknown as {window: unknown}).window = {
    matchMedia: () => ({matches: false}),
  };
  (globalThis as unknown as {document: unknown}).document = {
    hidden: false,
  };
  (globalThis as unknown as {CSS: unknown}).CSS = {
    supports: (_prop: string, value: string) => value === selectionSpring,
  };
  try {
    const container = fakeElement({left: 100, top: 200, width: 240, height: 48});
    const indicator = fakeElement({left: 108, top: 206, width: 80, height: 36});
    const first = fakeElement({left: 108, top: 206, width: 80, height: 36}, 'tab-a');
    const second = fakeElement({left: 196, top: 206, width: 104, height: 36}, 'tab-b');

    alignSelectionIndicator(
      container as unknown as HTMLElement,
      indicator as unknown as HTMLElement,
      first as unknown as HTMLElement,
      {axis: 'both', animate: true, key: 'a'},
    );
    assert.equal(indicator.hasAttribute('data-ready'), true);
    assert.equal(container.hasAttribute('data-selection-visible'), true);
    assert.equal(indicator.style.getPropertyValue('--selection-left'), '8px');
    assert.equal(indicator.style.getPropertyValue('--selection-top'), '6px');
    assert.equal(indicator.style.width, '80px');
    assert.equal(indicator.style.height, '36px');
    assert.equal(indicator.animateCalls.length, 0);

    // Selecting another item animates from the current painted rect with the 600ms Bento spring.
    alignSelectionIndicator(
      container as unknown as HTMLElement,
      indicator as unknown as HTMLElement,
      second as unknown as HTMLElement,
      {axis: 'both', animate: true, key: 'b'},
    );
    assert.equal(indicator.animateCalls.length, 1);
    const call = indicator.animateCalls[0]!;
    assert.equal(call.options.duration, 600);
    assert.equal(call.options.easing, selectionSpring);
    assert.deepEqual(call.keyframes, [
      {transform: 'translate3d(8px,6px,0) scale(0.7692307692307693,1)'},
      {transform: 'translate3d(96px,6px,0) scale(1,1)'},
    ]);

    // Resize updates coordinates without running the spring animation.
    second.setRect({left: 210, top: 206, width: 120, height: 36});
    alignSelectionIndicator(
      container as unknown as HTMLElement,
      indicator as unknown as HTMLElement,
      second as unknown as HTMLElement,
      {axis: 'both', animate: false, key: 'b'},
    );
    assert.equal(indicator.animateCalls.length, 0);
    assert.equal(indicator.style.getPropertyValue('--selection-left'), '110px');
    assert.equal(indicator.style.width, '120px');

    // Clearing the target removes ready & visibility markers.
    alignSelectionIndicator(container as unknown as HTMLElement, indicator as unknown as HTMLElement, null);
    assert.equal(indicator.hasAttribute('data-ready'), false);
    assert.equal(container.hasAttribute('data-selection-visible'), false);
    assert.equal(indicator.dataset.selectionKey, undefined);

    // Zero-sized (hidden panel) targets also clear markers and skip animations.
    const hiddenRow = fakeElement({left: 0, top: 0, width: 0, height: 0}, 'hidden-row');
    alignSelectionIndicator(
      container as unknown as HTMLElement,
      indicator as unknown as HTMLElement,
      first as unknown as HTMLElement,
      {axis: 'both', animate: true, key: 'a'},
    );
    assert.equal(indicator.hasAttribute('data-ready'), true);
    alignSelectionIndicator(
      container as unknown as HTMLElement,
      indicator as unknown as HTMLElement,
      hiddenRow as unknown as HTMLElement,
      {axis: 'both', animate: true, key: ''},
    );
    assert.equal(indicator.hasAttribute('data-ready'), false);
    assert.equal(container.hasAttribute('data-selection-visible'), false);
    assert.equal(indicator.dataset.selectionKey, undefined);
    assert.equal(indicator.animateCalls.length, 0);
  } finally {
    (globalThis as unknown as {window: unknown}).window = prevWindow;
    (globalThis as unknown as {document: unknown}).document = prevDocument;
    (globalThis as unknown as {CSS: unknown}).CSS = prevCSS;
  }
});

test('an opening menu measures its selection in unscaled layout coordinates', () => {
  const container = Object.assign(fakeElement({left: 200, top: 300, width: 96, height: 144}), {
    offsetWidth: 128, offsetHeight: 192, clientLeft: 1, clientTop: 1, scrollTop: 16,
  });
  const target = fakeElement({left: 205.25, top: 294, width: 87, height: 23.25});
  const indicator = fakeElement({left: 0, top: 0, width: 0, height: 0});

  alignSelectionIndicator(container as unknown as HTMLElement, indicator as unknown as HTMLElement, target as unknown as HTMLElement);
  assert.equal(indicator.style.getPropertyValue('--selection-left'), '6px');
  assert.equal(indicator.style.getPropertyValue('--selection-top'), '7px');
  assert.equal(indicator.style.width, '116px');
  assert.equal(indicator.style.height, '31px');
});

test('components with menu and selection motion remain SSR safe in Node ESM tests', () => {
  const indicatorHtml = renderToStaticMarkup(createElement(TabSelectionIndicator, {selection: 'form', axis: 'both'}));
  assert.match(indicatorHtml, /tab-selection-indicator/);
  assert.match(indicatorHtml, /data-axis="both"/);

  const selectHtml = renderToStaticMarkup(
    createElement(AppSelect, {label: 'Test', value: 'a', onChange: () => {}}, createElement('option', {value: 'a'}, 'A')),
  );
  assert.match(selectHtml, /app-select-trigger/);

  const closedMenu = renderToStaticMarkup(
    createElement(NavigationMenu, {open: false, title: 'Menu', x: 0, y: 0, actions: [], onClose: () => {}}),
  );
  assert.equal(closedMenu, '');

  const closedPermissions = renderToStaticMarkup(
    createElement(PermissionSettings, {
      anchor: {current: null},
      options: {},
      open: false,
      disabled: false,
      onChange: () => {},
      onClose: () => {},
    }),
  );
  assert.equal(closedPermissions, '');

  assert.ok(typeof ConversationDirectory === 'function');
  assert.ok(typeof MCPSettings === 'function');
  assert.ok(typeof CodexModelConfiguration === 'function');
  assert.ok(typeof SidebarWorkspaceNavigation === 'function');
  assert.ok(typeof PilotWorkspace === 'function');
  assert.ok(typeof WorkspaceConsole === 'function');

  const sidebarNavSource = readFileSync(new URL('../src/SidebarWorkspaceNavigation.tsx', import.meta.url), 'utf8');
  assert.match(sidebarNavSource, /sidebar-conversation-selection/);
  assert.match(sidebarNavSource, /sidebar-pilot-entry/);
  assert.match(sidebarNavSource, /chat-group-nav-row/);
});
