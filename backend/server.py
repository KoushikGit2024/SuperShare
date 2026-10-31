"""
server.py — SuperShare aiohttp server entry point.
Mirrors NER_RMCH/backend/server.py with the Windows Proactor fix and aiohttp router.
"""
import platform
import socket
from aiohttp import web

from .config import HOST, PORT, STATIC_DIR, TEMPLATE_DIR
from .api_routes import (
    status_handler,
    upload_permission_handler,
    pair_device_handler,
    devices_handler,
    rename_device_handler,
    forget_device_handler,
    revoke_device_handler,
    approve_device_handler,
    list_files_handler,
    host_folders_handler,
    pick_host_gui_handler,
    set_share_dir_handler,
    mkdir_handler,
    delete_selected_handler,
    download_handler,
    zip_folder_handler,
    zip_selected_handler,
    upload_handler,
)

# --- Windows asyncio fix (prevents noisy ConnectionResetError on close, from NER_RMCH) ---
if platform.system() == "Windows":
    from asyncio.proactor_events import _ProactorBasePipeTransport

    _orig = _ProactorBasePipeTransport._call_connection_lost

    def _silent(self, exc):
        try:
            _orig(self, exc)
        except (ConnectionResetError, ConnectionAbortedError):
            pass

    _ProactorBasePipeTransport._call_connection_lost = _silent


async def index_handler(request: web.Request) -> web.Response:
    return web.FileResponse(TEMPLATE_DIR / "index.html")


@web.middleware
async def api_error_middleware(request: web.Request, handler):
    try:
        return await handler(request)
    except PermissionError as exc:
        raise web.HTTPForbidden(text=str(exc)) from exc
    except FileNotFoundError as exc:
        raise web.HTTPNotFound(text=str(exc)) from exc


def create_app() -> web.Application:
    # Streaming is bounded by the request reader and per-chunk file writes.
    app = web.Application(client_max_size=0, middlewares=[api_error_middleware])

    # Main UI Page
    app.router.add_get("/", index_handler)

    # REST & Streaming API
    app.router.add_get("/api/status", status_handler)
    app.router.add_get("/api/upload-permission", upload_permission_handler)
    app.router.add_post("/api/pair", pair_device_handler)
    app.router.add_get("/api/devices", devices_handler)
    app.router.add_post("/api/devices/rename", rename_device_handler)
    app.router.add_post("/api/devices/forget", forget_device_handler)
    app.router.add_post("/api/devices/revoke", revoke_device_handler)
    app.router.add_post("/api/devices/approve", approve_device_handler)
    app.router.add_get("/api/list", list_files_handler)
    app.router.add_get("/api/host-folders", host_folders_handler)
    app.router.add_get("/api/pick-host-gui", pick_host_gui_handler)
    app.router.add_get("/api/download", download_handler)
    app.router.add_get("/api/zip", zip_folder_handler)
    app.router.add_get("/api/zip-selected", zip_selected_handler)

    app.router.add_post("/api/upload", upload_handler)
    app.router.add_post("/api/mkdir", mkdir_handler)
    app.router.add_post("/api/delete-selected", delete_selected_handler)
    app.router.add_post("/api/set-share-dir", set_share_dir_handler)

    # Static assets
    app.router.add_static("/static/", STATIC_DIR, show_index=False)

    return app


def _get_local_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    local_ip = _get_local_ip()

    print("\n" + "=" * 55)
    print("  ⚡  SUPERSHARE — RUNNING")
    print("=" * 55)
    print(f"  💻  Laptop UI : http://localhost:{PORT}")
    print(f"  📱  Phone UI  : http://{local_ip}:{PORT}/")
    print("=" * 55 + "\n")
    print("  Press CTRL+C to stop.\n")

    web.run_app(create_app(), host=HOST, port=PORT, print=None)
