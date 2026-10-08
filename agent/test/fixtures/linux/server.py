import json
import signal
from http.server import BaseHTTPRequestHandler, HTTPServer

signal.signal(signal.SIGHUP, lambda *_: None)

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        with open('/etc/lake-fixture/config.json', encoding='utf-8') as source:
            config = json.load(source)
        self.send_response(200 if config.get('healthy', False) else 503)
        self.end_headers()
        self.wfile.write(config.get('message', '').encode())

    def log_message(self, *_):
        pass

HTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
