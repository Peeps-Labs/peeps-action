"""An API test suite: requests and httpx against a small fleet API served
from this process, so the HTTP calls each test makes are the evidence."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest


class FleetApi(BaseHTTPRequestHandler):
    def _send(self, status, body, headers=()):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Set-Cookie", "session=abc123; HttpOnly")
        for name, value in headers:
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        sent = json.loads(self.rfile.read(length) or b"{}")
        # The status field was renamed: a test still reading `status` fails.
        self._send(
            201,
            {"id": "wo_1", "robotId": sent.get("robotId"), "state": "queued", "token": "wo-token-1"},
            [("Location", "/work-orders/wo_1")],
        )

    def do_GET(self):
        # Echoes the custom header, so a secret sent there reaches a body too.
        self._send(200, {"echo": self.headers.get("X-Fleet-Echo"), "items": [], "nextCursor": None})

    def log_message(self, *args):
        pass


@pytest.fixture(scope="session")
def fleet_url():
    server = ThreadingHTTPServer(("127.0.0.1", 0), FleetApi)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
