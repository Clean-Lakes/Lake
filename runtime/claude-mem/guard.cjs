// Lake's private-worker HTTP boundary. This preload uses public Node APIs;
// the pinned Claude-Mem package stays unchanged.
const fs = require("node:fs");
const crypto = require("node:crypto");
const http = require("node:http");
const { syncBuiltinESMExports } = require("node:module");
const token = fs
  .readFileSync(process.env.LAKE_CLAUDE_MEM_TOKEN_FILE, "utf8")
  .trim();
if (!/^[a-f0-9]{64}$/.test(token))
  throw new Error("Private index credential is unavailable");
const expected = Buffer.from("Bearer " + token);
const port = Number(process.env.CLAUDE_MEM_WORKER_PORT);
const ownURL = (value) => {
  try {
    const url = new URL(
      typeof value === "string" || value instanceof URL
        ? String(value)
        : value.url,
    );
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      Number(url.port) === port
    );
  } catch {
    return false;
  }
};
const fetch = globalThis.fetch.bind(globalThis);
// Upstream's own liveness probes are origin-less HTTP clients too.
globalThis.fetch = (input, init) => {
  if (!ownURL(input)) return fetch(input, init);
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set("Authorization", expected.toString());
  return fetch(input, { ...init, headers });
};
const createServer = http.createServer;
http.createServer = function (...args) {
  const index = args.findIndex((value) => typeof value === "function");
  if (index >= 0) {
    const handler = args[index];
    args[index] = function (request, response) {
      const supplied = Buffer.from(String(request.headers.authorization ?? ""));
      if (
        request.headers.origin ||
        supplied.length !== expected.length ||
        !crypto.timingSafeEqual(supplied, expected)
      ) {
        response.writeHead(401, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end('{"error":"Private Lake index"}');
        return;
      }
      return handler.call(this, request, response);
    };
  }
  return createServer.apply(this, args);
};
syncBuiltinESMExports();
