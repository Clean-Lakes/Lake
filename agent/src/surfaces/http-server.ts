import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, lstat } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { BootstrapAuth } from "./auth.js";
import { dispatchRoute } from "./routes.js";
import { streamEvents } from "./event-stream.js";
import type { LakeApplication } from "../app/application.js";
import { LakeError, publicError, requireCondition } from "../domain/errors.js";
export async function createHttpServer(
  app: LakeApplication,
  options: {
    port?: number;
    uiRoot?: string;
  } = {},
) {
  const auth = new BootstrapAuth();
  app.redactor.register(auth.token);
  (app as any).daemonNonce = auth.nonce;
  let origin = "";
  const server = createServer(async (req, res) => {
    try {
      requireCondition(
        req.headers.host === origin.replace("http://", "") &&
          (!req.headers.origin || req.headers.origin === origin),
        "unauthorized",
      );
      const url = new URL(req.url ?? "/", origin),
        path = url.pathname;
      if (path.startsWith("/api/v1/")) {
        res.setHeader("Cache-Control", "no-store");
        if (path === "/api/v1/bootstrap/exchange") {
          requireCondition(req.method === "POST", "not_found");
          const data = await readJson(req, 4096);
          requireCondition(typeof data.ticket === "string", "invalid_input");
          const result = auth.exchange(data.ticket);
          res.setHeader(
            "Set-Cookie",
            `lake_session=${auth.token}; HttpOnly; SameSite=Strict; Path=/api/v1`,
          );
          send(res, 200, result);
          return;
        }
        if (path === "/api/v1/bootstrap/session") {
          requireCondition(req.method === "GET", "not_found");
          const cookie = req.headers.cookie
            ?.split(";")
            .map((v) => v.trim())
            .find((v) => v.startsWith("lake_session="))
            ?.slice("lake_session=".length);
          auth.validate(cookie ? "Bearer " + cookie : undefined);
          send(res, 200, { token: auth.token });
          return;
        }
        auth.validate(req.headers.authorization);
        if (path === "/api/v1/launch") {
          requireCondition(req.method === "POST", "not_found");
          send(res, 200, { ticket: auth.issue() });
          return;
        }
        if (
          req.method === "GET" &&
          /^\/api\/v1\/sessions\/[^/]+\/events$/.test(path)
        ) {
          const id = path.split("/")[4]!;
          await app.data.snapshot(id);
          const after = url.searchParams.get("after") ?? "0";
          requireCondition(/^\d+$/.test(after), "invalid_input");
          await streamEvents(app, id, after, res);
          return;
        }
        const body =
          req.method === "POST"
            ? await readJson(req, app.config.limits.maxApiBodyBytes)
            : undefined;
        send(
          res,
          200,
          await dispatchRoute(
            app,
            req.method ?? "",
            path.slice("/api/v1/".length),
            url.searchParams,
            body,
          ),
        );
        return;
      }
      requireCondition(req.method === "GET" && options.uiRoot, "not_found");
      const root = resolve(options.uiRoot),
        target = resolve(
          root,
          path === "/" ? "index.html" : "." + decodeURIComponent(path),
        );
      requireCondition(target.startsWith(root + "/"), "scope_denied");
      const stat = await lstat(target);
      requireCondition(
        stat.isFile() && !stat.isSymbolicLink() && stat.size < 10485760,
        "not_found",
      );
      const mime: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css",
        ".svg": "image/svg+xml",
      };
      res.writeHead(200, {
        "Content-Type": mime[extname(target)] ?? "application/octet-stream",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(await readFile(target));
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const safe = publicError(error),
        status =
          safe.code === "unauthorized" || safe.code === "scope_denied"
            ? 403
            : safe.code === "not_found"
              ? 404
              : safe.code === "conflict"
                ? 409
                : safe.code === "output_limit"
                  ? 413
                  : 400;
      send(res, status, { error: safe });
    }
  });
  await new Promise<void>((r) =>
    server.listen(options.port ?? 0, "127.0.0.1", r),
  );
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    auth,
    origin,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}
async function readJson(req: IncomingMessage, maxBytes: number): Promise<any> {
  requireCondition(
    req.headers["content-type"]?.split(";")[0] === "application/json",
    "invalid_input",
  );
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    requireCondition(bytes <= maxBytes, "output_limit");
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new LakeError("invalid_input", "Invalid JSON body");
  }
}
