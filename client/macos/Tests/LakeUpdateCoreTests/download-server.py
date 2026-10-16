"""Loopback-only throttled fixtures; no release data or credentials."""
import http.server
import pathlib
import sys
import time


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        chunked = self.path == "/chunked"
        self.send_response(200)
        self.send_header("Transfer-Encoding" if chunked else "Content-Length",
                         "chunked" if chunked else str(1024 * 1024))
        self.end_headers()
        try:
            for _ in range(16):
                data = b"L" * (64 * 1024)
                self.wfile.write((b"10000\r\n" + data + b"\r\n") if chunked else data)
                self.wfile.flush()
                time.sleep(0.08)
            if chunked:
                self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
pathlib.Path(sys.argv[1]).write_text(str(server.server_port))
server.serve_forever()
