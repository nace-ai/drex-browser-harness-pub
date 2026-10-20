"""Serves e2e/site on 127.0.0.1:8765 (or the port given as the first argument), plus /longpoll: a request that hangs 25 s before answering, like Gmail's
always-open background channel (the test mailbox opens one with ?longpoll=1)."""
import functools, http.server, pathlib, sys, time

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/longpoll"):
            time.sleep(25)
            self.send_response(204)
            self.end_headers()
            return
        super().do_GET()

    def log_message(self, *a):
        pass

site = pathlib.Path(__file__).parent / "site"
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=str(site))).serve_forever()
