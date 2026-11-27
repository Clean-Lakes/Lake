import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import { HttpError } from "./store";

export const isPrivateIPv4 = (address: string | undefined): address is string => {
  if (!address) return false;
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (!isIPv4(normalized)) return false;
  const [first, second] = normalized.split(".").map(Number);
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
};

export const isLocalOrPrivateIPv4 = (address: string | undefined): boolean => {
  if (!address) return false;
  if (address === "::1") return true;
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (!isIPv4(normalized)) return false;
  return normalized.startsWith("127.") || isPrivateIPv4(normalized);
};

/** Select the best LAN IPv4 interface for external MCP clients on the local network. */
export function detectLanIPv4(): string | null {
  const interfaces = networkInterfaces();
  const candidates: { address: string; priority: number }[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (String(entry.family) !== "IPv4" || entry.internal || !isPrivateIPv4(entry.address)) continue;
      let priority = 3;
      if (/^(en0|en1|eth0|wlan0)$/i.test(name)) priority = 0;
      else if (/^(en\d+|eth\d+)$/i.test(name)) priority = 1;
      else if (/^(utun|bridge|awdl|llw|anpi|docker|veth)/i.test(name)) priority = 4;
      else priority = 2;
      candidates.push({ address: entry.address, priority });
    }
  }
  candidates.sort((a, b) => a.priority - b.priority || a.address.localeCompare(b.address));
  return candidates[0]?.address ?? null;
}

/** Dedicated LAN HTTP ingress exposing ONLY `/api/gateway/*` to private-network MCP clients.
 * The main Lake UI and settings endpoints remain strictly bound to loopback. */
export class GatewayLanIngress {
  private server: Server | null = null;
  private boundOrigin: string | null = null;
  private starting: Promise<string | null> | null = null;
  private closed = false;

  constructor(
    private readonly dispatch: (request: IncomingMessage, response: ServerResponse, ingressOrigin: string) => void,
    private readonly readSavedPort?: () => number | undefined,
    private readonly savePort?: (port: number) => void,
  ) {}

  origin(): string | null {
    return this.boundOrigin;
  }

  async ensure(fallbackOrigin: string): Promise<string> {
    if (this.boundOrigin) return this.boundOrigin;
    if (this.closed) return fallbackOrigin;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return (await this.starting) ?? fallbackOrigin;
  }

  private async start(): Promise<string | null> {
    const host = detectLanIPv4();
    if (!host) return null;
    const savedPort = this.readSavedPort?.();
    const ports = savedPort && savedPort > 0 && savedPort < 65536 ? [savedPort, 0] : [0];

    for (const port of ports) {
      const server = createServer((request, response) => {
        if (!isLocalOrPrivateIPv4(request.socket.remoteAddress)) {
          response.writeHead(403, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ error: "仅允许内网地址访问 Lake MCP 接入端口" }));
          return;
        }
        const rawUrl = request.url ?? "/";
        if (!rawUrl.startsWith("/api/gateway/") && rawUrl !== "/api/gateway") {
          response.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ error: "仅开放 MCP 接入路径" }));
          return;
        }
        this.dispatch(request, response, this.boundOrigin ?? `http://${host}:${port}`);
      });
      try {
        const bound = await new Promise<string>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, host, () => {
            const addr = server.address();
            if (!addr || typeof addr === "string") return reject(new HttpError(500, "无法确定内网 MCP 端口"));
            resolve(`http://${host}:${addr.port}`);
          });
        });
        this.server = server;
        this.boundOrigin = bound;
        const actualPort = Number(new URL(bound).port);
        if (actualPort && actualPort !== savedPort) {
          try { this.savePort?.(actualPort); } catch {}
        }
        return bound;
      } catch (error) {
        server.close();
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE" && port !== 0) continue;
        return null;
      }
    }
    return null;
  }

  async close(): Promise<void> {
    this.closed = true;
    const server = this.server;
    this.server = null;
    this.boundOrigin = null;
    if (!server) return;
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}
