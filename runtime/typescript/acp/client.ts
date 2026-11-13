import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream, type ClientConnection } from '@agentclientprotocol/sdk';

export type AcpLaunch = { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  observed?:{model:string;modelProvider:string;reasoningEffort?:string;authenticated:boolean;authMode:'chatgpt'|'api_key'|'provider'|'none'} };
export type AcpHandlers = {
  request: (method: string, params: any, callId: string) => Promise<unknown>;
  update: (params: any) => void;
};
/** A single owned subprocess. No shell interpolation and no cross-task process pool. */
export class AcpProcess {
  readonly process: ChildProcess;
  readonly connection: ClientConnection;
  private stderr = '';
  private closing?: Promise<void>;
  constructor(launch: AcpLaunch, handlers: AcpHandlers) {
    this.process = spawn(launch.executable, launch.args, { cwd: launch.cwd, env: launch.env,
      shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const proc = this.process;
    if (!proc.stdin || !proc.stdout || !proc.stderr) throw new Error('ACP 标准输入输出不可用');
    proc.stderr.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-65536); });
    const app = client().onRequest('*', async ctx => {
      if (ctx.method === 'session/request_permission') {
        try{return await handlers.request(ctx.method,ctx.params,String(ctx.requestId));}
        catch{return {outcome:{outcome:'cancelled'}};}
      }
      return handlers.request(ctx.method, ctx.params, String(ctx.requestId));
    }).onNotification('session/update', ctx => handlers.update(ctx.params));
    this.connection = app.connect(ndJsonStream(Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>, { maxMessageBytes: 8 * 1024 * 1024 }));
    proc.once('error', error => this.connection.close(error));
    proc.once('exit', (code, signal) => this.connection.close(new Error(`ACP 进程已退出 (${signal ?? code ?? 'unknown'})`)));
  }
  async request<T = any>(method: string, params: unknown, signal: AbortSignal, timeout = 120000): Promise<T> {
    signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const stop = () => controller.abort(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    try {
      timer = setTimeout(() => controller.abort(new Error('ACP 请求等待超时')), timeout);
      return await this.connection.agent.request<T, unknown>(method, params, { cancellationSignal: controller.signal, stopWaitingOnCancel: true });
    } finally { clearTimeout(timer); signal.removeEventListener('abort', stop); }
  }
  async cancel(sessionId?: string) {
    if (sessionId && !this.connection.signal.aborted)
      await this.connection.agent.notify('session/cancel', { sessionId }).catch(() => {});
  }
  diagnostics() { return this.stderr; }
  close() { return this.closing ??= this.end(); }
  private async end() {
    this.connection.close();
    this.process.stdin?.end();
    if (!this.process.pid) return;
    const pid = this.process.pid;
    const kill = (signal: NodeJS.Signals) => {
      try { if (process.platform === 'win32') this.process.kill(signal); else process.kill(-pid, signal); } catch { /* already gone */ }
    };
    kill('SIGTERM');
    if (this.process.exitCode === null) await Promise.race([new Promise<void>(resolve => this.process.once('exit', () => resolve())), new Promise<void>(resolve => setTimeout(resolve, 300))]);
    // The group may still have descendants after the adapter itself exits.
    kill('SIGKILL');
  }
}
