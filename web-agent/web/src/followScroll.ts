type ScrollBox = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">;
type Frames = { request: (callback: FrameRequestCallback) => number; cancel: (id: number) => void };

export function conversationCanScroll(box: ScrollBox) {
  return box.scrollHeight - box.clientHeight >= 2;
}

// A downward gesture at the tail (or any gesture before overflow) must not
// leave following paused when the browser has no scroll event to resume it.
export function pausesConversationFollow(box: ScrollBox, direction: number) {
  return conversationCanScroll(box) && (direction < 0 || !atConversationTail(box));
}

// DOM heights are integers, but scrollTop and the clamped tail may be fractional.
// Resume following only at the actual tail, including this rounding tolerance.
export function atConversationTail(box: ScrollBox) {
  return Math.abs(Math.max(0, box.scrollHeight - box.clientHeight) - box.scrollTop) < 2;
}

// Snapshot arrival changes the destination, not the animation cadence. All
// geometry reads and the single scroll write are coalesced into display frames.
export class FollowScroll {
  private frame: number | null = null;
  private previousTime: number | null = null;
  get animating() { return this.frame !== null; }
  constructor(private box: ScrollBox, private following: () => boolean,
    private frames: Frames = {request: callback => window.requestAnimationFrame(callback), cancel: id => window.cancelAnimationFrame(id)}, private reducedMotion = false) {}
  request() {
    if (!this.following() || this.frame !== null) return;
    // Cursor/activity updates are not necessarily new content. Avoid starting
    // an animation and writing scrollTop again when already at the tail.
    if (atConversationTail(this.box)) return;
    this.frame = this.frames.request(this.tick);
  }
  jump() {
    this.stop();
    if (this.following()) this.box.scrollTop = Math.max(0, this.box.scrollHeight - this.box.clientHeight);
  }
  stop() {
    if (this.frame !== null) this.frames.cancel(this.frame);
    this.frame = null; this.previousTime = null;
  }
  private tick = (time: number) => {
    if (!this.following()) { this.stop(); return; }
    const destination = Math.max(0, this.box.scrollHeight - this.box.clientHeight);
    const current = this.box.scrollTop;
    const delta = Math.min(32, Math.max(1, this.previousTime === null ? 16.67 : time - this.previousTime));
    this.previousTime = time;
    const gap = destination - current;
    // Browsers quantize scrollTop to device pixels. Finish before a subpixel
    // easing step rounds back to the same position and leaves the loop alive.
    if (this.reducedMotion || Math.abs(gap) < 2) {
      this.box.scrollTop = destination; this.frame = null; this.previousTime = null; return;
    }
    const step = Math.max(1, Math.abs(gap) * (1 - Math.exp(-delta / 65)));
    this.box.scrollTop = current + Math.sign(gap) * step;
    this.frame = this.frames.request(this.tick);
  };
}
