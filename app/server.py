"""Compatibility entry point that delegates to the canonical aiohttp service."""
from aiohttp import web

from backend.config import HOST, PORT, STATE
from backend.server import create_app


def start_server(host: str = HOST, port: int = PORT, share_dir: str | None = None):
    """Preserve the legacy import path without maintaining a second server."""
    if share_dir:
        STATE["share_dir"] = share_dir
    web.run_app(create_app(), host=host, port=port, print=None)
