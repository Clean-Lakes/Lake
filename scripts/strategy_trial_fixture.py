#!/usr/bin/env python3
"""Disposable loopback /health trials; no Lake data or credentials are read."""
import argparse
import datetime
import json
import os
import signal
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def endpoint(recover):
    lock = threading.Lock()
    state = {"samples": 0}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            if self.path == "/status":
                with lock:
                    payload = dict(state)
            elif self.path == "/health":
                with lock:
                    state["samples"] += 1
                    sample = state["samples"]
                if not recover or sample == 1:
                    self.close_connection = True
                    try:
                        self.connection.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    self.connection.close()
                    return
                payload = {"healthy": True, "fixture": True, "sample": sample,
                           "scope": "Disposable endpoint only; not business recovery."}
            else:
                self.send_error(404)
                return
            raw = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}/health"
    return server, thread, {"url": url, "command": f"curl -sS --max-time 2 {url}"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ttl-seconds", type=int, default=7200)
    args = parser.parse_args()
    if not 1 <= args.ttl_seconds <= 7200:
        parser.error("ttl-seconds must be 1..7200")
    stopped = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stopped.set())
    servers = []
    try:
        info = {}
        for name, recover in (("recovery", True), ("persistent", False)):
            server, thread, info[name] = endpoint(recover)
            servers.append((server, thread))
        info["pid"] = os.getpid()
        info["expiresAt"] = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=args.ttl_seconds)).isoformat()
        print(json.dumps(info), flush=True)
        stopped.wait(args.ttl_seconds)
    finally:
        for server, thread in servers:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    main()
