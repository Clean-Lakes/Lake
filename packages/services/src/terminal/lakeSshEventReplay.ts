import { Emitter, type Event } from "@zcode/rpc";

const maxEarlyOutputLength = 64 * 1024;
const noSubscription = { dispose() {} };

/** 保留 SSH 启动瞬间的错误输出和退出状态，直到 Renderer 完成订阅。 */
export function createLakeSshEventReplay(): {
  onData: Event<string>;
  onExit: Event<number>;
  emitData(data: string): void;
  emitExit(code: number): void;
  dispose(): void;
  readonly exitCode: number | null;
} {
  const dataEmitter = new Emitter<string>();
  const exitEmitter = new Emitter<number>();
  let earlyOutput = "";
  let hasDataSubscriber = false;
  let exitCode: number | null = null;
  let disposed = false;

  return {
    onData(listener) {
      if (disposed) return noSubscription;
      const subscription = dataEmitter.event(listener);
      if (!hasDataSubscriber) {
        hasDataSubscriber = true;
        if (earlyOutput) listener(earlyOutput);
        earlyOutput = "";
      }
      return subscription;
    },
    onExit(listener) {
      if (disposed) return noSubscription;
      if (exitCode !== null) {
        listener(exitCode);
        return noSubscription;
      }
      return exitEmitter.event(listener);
    },
    emitData(data) {
      if (disposed || exitCode !== null) return;
      if (!hasDataSubscriber) {
        // Renderer 尚未订阅时只保留有限的启动输出，避免恶意目标无限占用 Host 内存。
        earlyOutput = (earlyOutput + data).slice(-maxEarlyOutputLength);
      }
      dataEmitter.fire(data);
    },
    emitExit(code) {
      if (disposed || exitCode !== null) return;
      exitCode = code;
      exitEmitter.fire(code);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      earlyOutput = "";
      dataEmitter.dispose();
      exitEmitter.dispose();
    },
    get exitCode() {
      return exitCode;
    },
  };
}
