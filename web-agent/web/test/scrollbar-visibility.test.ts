import assert from "node:assert/strict";
import test from "node:test";
import {initializeScrollbarVisibility} from "../src/scrollbarVisibility";

test("scrollbars reveal and become idle independently after their last scroll", t => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  class Scroller {
    activity: string | null = null;
    getAttribute() { return this.activity; }
    setAttribute(_name: string, activity: string) { this.activity = activity; }
  }
  const outer = new Scroller();
  const inner = new Scroller();
  const root = new Scroller();
  let scroll!: (event: {target: unknown}) => void;
  const doc = {
    defaultView: {Element: Scroller, setTimeout, clearTimeout},
    scrollingElement: root,
    addEventListener(event: string, handler: typeof scroll, options: AddEventListenerOptions) {
      assert.equal(event, "scroll");
      assert.equal(options.capture, true);
      assert.equal(options.passive, true);
      scroll = handler;
    },
  };
  initializeScrollbarVisibility(doc as unknown as Document);

  scroll({target: inner});
  assert.equal(inner.activity, "scrolling");
  assert.equal(outer.activity, null);
  assert.equal(root.activity, null);
  t.mock.timers.tick(600);

  scroll({target: inner});
  scroll({target: doc});
  assert.equal(root.activity, "scrolling");
  t.mock.timers.tick(500);
  assert.equal(inner.activity, "scrolling");

  scroll({target: outer});
  t.mock.timers.tick(500);
  assert.equal(inner.activity, "idle");
  assert.equal(root.activity, "idle");
  assert.equal(outer.activity, "scrolling");
  t.mock.timers.tick(500);
  assert.equal(outer.activity, "idle");
});
