"""
server.py — SuperShare aiohttp server entry point.
Mirrors NER_RMCH/backend/server.py with the Windows Proactor fix and aiohttp router.
"""
import platform
import socket
import asyncio
import json
from aiohttp import web

from .config import HOST, PORT, STATIC_DIR, TEMPLATE_DIR
from .api_routes import (
    status_handler,
    upload_permission_handler,
    pair_device_handler,
    confirm_pairing_handler,
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
    network_handler,
    pairing_qr_handler,
    diagnostics_handler,
    create_transfer_handler,
    transfer_chunk_handler,
    transfer_status_handler,
    complete_transfer_handler,
    cancel_transfer_handler,
    _host_interfaces,
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


async def _discovery_broadcaster(app):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    try:
        while True:
            payload = json.dumps({"service": "SuperShare", "protocol_version": 1, "port": app["port"],
                                  "scheme": app["scheme"],
                                  "ca_fingerprint": app["tls_info"].get("ca_fingerprint")}).encode("utf-8")
            targets = {item["broadcast"] for item in _host_interfaces() if item.get("broadcast")}
            targets.add("255.255.255.255")
            for target in targets:
                try:
                    sock.sendto(payload, (target, 8766))
                except OSError:
                    continue
            await asyncio.sleep(5)
    except asyncio.CancelledError:
        raise
    finally:
        sock.close()


async def _start_discovery(app):
    app["discovery_task"] = asyncio.create_task(_discovery_broadcaster(app))


async def _stop_discovery(app):
    task = app.get("discovery_task")
    if task:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


@web.middleware
async def api_error_middleware(request: web.Request, handler):
    try:
        return await handler(request)
    except PermissionError as exc:
        raise web.HTTPForbidden(text=str(exc)) from exc
    except FileNotFoundError as exc:
        raise web.HTTPNotFound(text=str(exc)) from exc


def create_app(port=PORT, tls_info=None) -> web.Application:
    # Streaming is bounded by the request reader and per-chunk file writes.
    app = web.Application(client_max_size=0, middlewares=[api_error_middleware])
    app["port"] = port
    app["scheme"] = "https" if tls_info else "http"
    app["tls_info"] = tls_info or {}
    app.on_startup.append(_start_discovery)
    app.on_cleanup.append(_stop_discovery)

    # Main UI Page
    app.router.add_get("/", index_handler)

    # REST & Streaming API
    app.router.add_get("/api/status", status_handler)
    app.router.add_get("/api/network", network_handler)
    app.router.add_get("/api/pairing-qr", pairing_qr_handler)
    app.router.add_get("/api/diagnostics", diagnostics_handler)
    app.router.add_get("/api/upload-permission", upload_permission_handler)
    app.router.add_post("/api/pair", pair_device_handler)
    app.router.add_post("/api/devices/confirm-pairing", confirm_pairing_handler)
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
    app.router.add_post("/api/transfers", create_transfer_handler)
    app.router.add_put("/api/transfers/{job_id}/chunk", transfer_chunk_handler)
    app.router.add_get("/api/transfers/{job_id}", transfer_status_handler)
    app.router.add_post("/api/transfers/{job_id}/complete", complete_transfer_handler)
    app.router.add_post("/api/transfers/{job_id}/cancel", cancel_transfer_handler)
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

    web.run_app(create_app(port=PORT), host=HOST, port=PORT, print=None)
