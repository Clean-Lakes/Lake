export class DragAutoScroll {
  private remainder = 0;

  constructor(private previousTime: number) {}

  step(box: Pick<HTMLElement, "scrollTop"> | null, pixelsPerSecond: number, time: number): boolean {
    // Discard the gap left by a suspended or busy rendering loop.
    const elapsed = Math.min(50, Math.max(0, time - this.previousTime));
    this.previousTime = time;
    if (!box || !pixelsPerSecond) {
      this.remainder = 0;
      return false;
    }
    const distance = pixelsPerSecond * elapsed / 1000 + this.remainder;
    const before = box.scrollTop;
    box.scrollTop = before + distance;
    const moved = box.scrollTop - before;
    const remainder = distance - moved;
    // Preserve a subpixel step when the browser rounds scrollTop. At a
    // scroll boundary, discard accumulated distance once it reaches a pixel.
    this.remainder = Math.abs(remainder) < 1 ? remainder : 0;
    return moved !== 0;
  }
}
