import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createConnection, isIPv4 } from 'node:net';
import { HttpError } from './store';

export const grafanaIngressPath = (sourceId: string) => '/api/ingress/v1/grafana/' + sourceId;
const ingress = /^\/api\/ingress\/v1\/grafana\/([a-zA-Z0-9_-]{1,128})$/;

const localIPv4 = (address: string | undefined): address is string => {
  if (!address || !isIPv4(address)) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 127 || first === 10 || (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
};

function addressFor(endpoint: string, signal: AbortSignal) {
  const target = new URL(endpoint);
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({host: target.hostname, port, family: 4, signal});
    socket.once('error', () => reject(new HttpError(409, '无法确定到 Grafana 的内网地址')));
    socket.once('connect', () => {
      const {localAddress, remoteAddress} = socket;
      socket.destroy();
      if (localIPv4(localAddress) && localIPv4(remoteAddress)) resolve(localAddress);
      else reject(new HttpError(409, '自动接入需要 Grafana 和 Lake 之间的内网连接'));
    });
  });
}

type Listener = {server: Server; host: string; port: number; ready: Promise<string>};
type Probe = {base: string; bearer: Buffer; received: boolean};

/** Callback sockets dispatch only scoped notifications and short-lived Grafana reachability checks. */
export class GrafanaLocalIngress {
  private readonly listeners = new Set<Listener>();
  private readonly probes = new Map<string, Probe>();
  private stopping = false;

  constructor(private readonly receive: (id: string, request: IncomingMessage, base: string, isStopping: () => boolean) => Promise<unknown>) {}

  private listen(host: string, port: number) {
    if (this.stopping) throw new HttpError(503, 'Lake 正在退出');
    for (const listener of this.listeners) {
      const current = listener.server.address();
      if (listener.host === host && (!port || listener.port === port || (current && typeof current !== 'string' && current.port === port)))
        return listener.ready;
    }

    let base: string;
    const server = createServer({headersTimeout: 5_000, requestTimeout: 12_000, keepAliveTimeout: 1_000,
      connectionsCheckingInterval: 1_000}, async (request, response) => {
      response.setHeader('Connection', 'close');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      try {
        const sourceId = ingress.exec(request.url ?? '')?.[1];
        if (!sourceId || !localIPv4(request.socket.remoteAddress)) throw new HttpError(404, 'Grafana 接收地址不存在');
        if (request.method !== 'POST') throw new HttpError(405, 'Grafana Webhook 仅接受 POST');
        if (this.stopping) throw new HttpError(503, 'Lake 正在退出');
        const probe = this.probes.get(sourceId);
        if (probe) {
          const supplied = Buffer.from(request.headers.authorization ?? '');
          if (probe.base !== base || probe.bearer.length !== supplied.length || !timingSafeEqual(probe.bearer, supplied))
            throw new HttpError(401, 'Grafana Webhook 探测凭据无效');
          probe.received = true;
          request.resume();
          response.end('{}');
          return;
        }
        response.end(JSON.stringify(await this.receive(sourceId, request, base, () => this.stopping)));
      } catch (error) {
        response.statusCode = error instanceof HttpError ? error.status : 500;
        response.end(JSON.stringify({error: error instanceof HttpError ? error.message : 'Lake 收件失败'}));
      }
    });
    server.maxConnections = 32;
    const ready = new Promise<string>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        const address = server.address();
        if (!address || typeof address === 'string') return reject(new Error('Grafana receiver address missing'));
        base = `http://${host}:${address.port}`;
        resolve(base);
      });
    });
    const listener = {server, host, port, ready};
    this.listeners.add(listener);
    void ready.catch(() => this.listeners.delete(listener));
    return ready;
  }

  async restore(base: string) {
    const {hostname, port, protocol} = new URL(base);
    if (!localIPv4(hostname) || !port || protocol !== 'http:' || base !== `http://${hostname}:${port}`)
      throw new HttpError(409, '已保存的 Grafana 内网接收地址无效');
    await this.listen(hostname, Number(port));
  }

  ready(base: string) {
    return [...this.listeners].some(({server, host}) => {
      const address = server.address();
      return !!address && typeof address !== 'string' && base === `http://${host}:${address.port}`;
    });
  }

  async open(endpoint: string, previous: string | undefined, signal: AbortSignal) {
    const host = await addressFor(endpoint, signal);
    signal.throwIfAborted();
    if (previous && new URL(previous).hostname === host) {
      try {
        await this.restore(previous);
        return previous;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      }
    }
    try { return await this.listen(host, 0); }
    catch { throw new HttpError(409, 'Lake 无法在当前内网地址启动 Grafana 接收端口'); }
  }

  async verify(base: string, deliver: (url: string, token: string) => Promise<unknown>) {
    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    const probe = {base, bearer: Buffer.from('Bearer ' + token), received: false};
    this.probes.set(id, probe);
    try {
      await deliver(base + grafanaIngressPath(id), token);
      if (!probe.received) throw new HttpError(409, 'Grafana 的测试通知未到达 Lake 接收端口');
    } finally {
      this.probes.delete(id);
    }
  }

  async close() {
    this.stopping = true;
    await Promise.all([...this.listeners].map(async ({server, ready}) => {
      if (!(await ready.catch(() => false))) return;
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }));
    this.listeners.clear();
  }
}
