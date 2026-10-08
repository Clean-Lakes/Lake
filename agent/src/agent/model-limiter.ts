import type { ModelPort, ModelRequest, ModelEvent } from "../domain/ports.js";
import { LakeError } from "../domain/errors.js";
export class ModelLimiter {
  private active = 0;
  private readonly waiting: {
    resolve: () => void;
    reject: (e: unknown) => void;
    signal: AbortSignal;
    abort: () => void;
  }[] = [];
  constructor(private readonly limit = 2) {}
  private async acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new LakeError("cancelled");
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const item = {
        resolve,
        reject,
        signal,
        abort: () => {
          const i = this.waiting.indexOf(item);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(new LakeError("cancelled"));
        },
      };
      this.waiting.push(item);
      signal.addEventListener("abort", item.abort, { once: true });
    });
  }
  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next.signal.removeEventListener("abort", next.abort);
      next.resolve();
    } else this.active--;
  }
  wrap(model: ModelPort): ModelPort {
    const limiter = this;
    return {
      async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
        await limiter.acquire(request.signal);
        try {
          yield* model.stream(request);
        } finally {
          limiter.release();
        }
      },
    };
  }
}
