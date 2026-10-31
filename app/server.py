from http.server import ThreadingHTTPServer
from app.handler import SuperShareRequestHandler


def start_server(host: str, port: int, share_dir: str):
    server = ThreadingHTTPServer((host, port), SuperShareRequestHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[STOP] SuperShare server stopped.")
        server.server_close()
