#!/usr/bin/env python3
"""Local integration testing: proxies /ai/* to authd, mimicking the nginx setup.

For local dev self-testing only; not deployed. Usage:
    python3 dev_proxy.py            # listens on 9122
    then open http://127.0.0.1:9122/ai/ in a browser
"""

import http.client
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PREFIX = "/ai"
UPSTREAM = ("127.0.0.1", int(os.environ.get("MUSCOVADO_PORT", "9120")))

# Important: do NOT rewrite Origin here.
# Pass through whatever the browser sends, so authd sees the real browser
# origin and an allowed_origins entry of http://127.0.0.1:9122 matches.
# An earlier version forced Origin to the first configured value, which never
# matched the browser on port 9122 during local debugging and got every POST
# rejected with 403.

class Proxy(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _proxy(self, method: str) -> None:
        path = self.path
        if not path.startswith(PREFIX + "/") and path != PREFIX:
            self.send_error(404)
            return
        target = path[len(PREFIX):] or "/"

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        conn = http.client.HTTPConnection(*UPSTREAM, timeout=300)
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() not in ("host", "connection", "content-length")}
        headers["X-Real-IP"] = self.client_address[0]
        headers["X-Forwarded-Proto"] = "https"
        conn.request(method, target, body=body, headers=headers)
        resp = conn.getresponse()

        # Streaming upstream (NDJSON): read and write incrementally, re-encoding as chunked.
        # The upstream signals the end with chunked encoding (0\r\n\r\n); forwarding the
        # same encoding lets the browser know the body ended, instead of waiting for the
        # connection to close.
        ctype = (resp.getheader("Content-Type") or "")
        streaming = "ndjson" in ctype

        self.send_response(resp.status)
        for key, value in resp.getheaders():
            if key.lower() in ("transfer-encoding", "connection", "content-length"):
                continue
            self.send_header(key, value)
        if streaming:
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            try:
                while True:
                    chunk = resp.read1(65536)
                    if not chunk:
                        break
                    self.wfile.write(b"%x\r\n" % len(chunk) + chunk + b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            conn.close()
            return

        data = resp.read()
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if method != "HEAD":
            self.wfile.write(data)
        conn.close()

    def do_GET(self):
        self._proxy("GET")

    def do_HEAD(self):
        self._proxy("HEAD")

    def do_POST(self):
        self._proxy("POST")

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    print("dev proxy: http://127.0.0.1:9122/ai/  ->  authd", UPSTREAM)
    ThreadingHTTPServer(("127.0.0.1", 9122), Proxy).serve_forever()
