import type { Readable } from "node:stream";

export interface StreamChunk { data: Buffer; truncated: boolean }
interface Waiter { marker: Buffer; limit: number; resolve(value: StreamChunk): void; reject(error: Error): void }
export class DelimitedStream {
  private buffer = Buffer.alloc(0);
  private output = Buffer.alloc(0);
  private truncated = false;
  private waiter?: Waiter;
  private ended = false;
  constructor(stream: Readable) {
    stream.on("data", chunk => { this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]); this.drain(); });
    stream.on("end", () => this.end()); stream.on("error", () => this.end());
  }
  read(marker: Buffer, limit: number): Promise<StreamChunk> {
    if (this.waiter) throw new Error("终端流已有读取者");
    if (this.ended) return Promise.reject(new Error("终端流已关闭"));
    return new Promise((resolve, reject) => { this.waiter = { marker, limit, resolve, reject }; this.output = Buffer.alloc(0); this.truncated = false; this.drain(); });
  }
  end(): void { this.ended = true; this.waiter?.reject(new Error("终端流中断")); this.waiter = undefined; }
  private drain(): void {
    const waiter = this.waiter;
    if (!waiter) { if (this.buffer.length > 256 * 1024) this.buffer = this.buffer.subarray(this.buffer.length - 256 * 1024); return; }
    const index = this.buffer.indexOf(waiter.marker), end = index >= 0 ? index : Math.max(0, this.buffer.length - waiter.marker.length + 1);
    const available = Math.max(0, waiter.limit - this.output.length);
    if (end > available) this.truncated = true;
    this.output = Buffer.concat([this.output, this.buffer.subarray(0, Math.min(end, available))]);
    this.buffer = this.buffer.subarray(end + (index >= 0 ? waiter.marker.length : 0));
    if (index >= 0) { this.waiter = undefined; waiter.resolve({ data: this.output, truncated: this.truncated }); }
  }
}
