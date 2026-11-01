"""
server.py — SuperShare aiohttp server entry point.
Mirrors NER_RMCH/backend/server.py with the Windows Proactor fix and aiohttp router.
"""
import platform
import socket
import asyncio
import json
import re
import os
import aiohttp
from aiohttp import web

import time
from .config import HOST, PORT, STATIC_DIR, TEMPLATE_DIR, STATE, request_save, cleanup_expired_transfer_jobs
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
    storage_info_handler,
    clear_history_handler,
    clear_partials_handler,
    reset_state_handler,
    mkdir_handler,
    delete_selected_handler,
    download_handler,
    preview_file_handler,
    zip_folder_handler,
    zip_selected_handler,
    zip_preflight_handler,
    download_stop_handler,
    device_policy_handler,
    device_terminate_handler,
    network_handler,
    pairing_qr_handler,
    diagnostics_handler,
    create_transfer_handler,
    transfer_chunk_handler,
    transfer_status_handler,
    complete_transfer_handler,
    cancel_transfer_handler,
    _host_interfaces,
    _expire_stale_jobs,
    speedtest_down_handler,
    speedtest_up_handler,
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


async def speedtest_page_handler(request: web.Request) -> web.StreamResponse:
    raise web.HTTPFound("/static/speedtest.html")


async def index_handler(request: web.Request) -> web.Response:
    index_file = TEMPLATE_DIR / "index.html"
    if not index_file.is_file():
        raise web.HTTPNotFound(text="Template index.html not found")
    
    html = index_file.read_text(encoding="utf-8")
    partials_dir = TEMPLATE_DIR / "partials"

    def _replace_include(match):
        rel_name = match.group(1).replace("partials/", "")
        p_file = partials_dir / rel_name
        if p_file.is_file():
            return p_file.read_text(encoding="utf-8")
        return f"<!-- Missing partial: {rel_name} -->"

    composed_html = re.sub(r'<!--#include file="([^"]+)"-->', _replace_include, html)
    return web.Response(text=composed_html, content_type="text/html", charset="utf-8")


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


async def _loop_lag_monitor():
    loop = asyncio.get_running_loop()
    while True:
        before = loop.time()
        await asyncio.sleep(0.1)
        lag = loop.time() - before - 0.1
        if lag > 0.1:
            print(f"[LAG] event loop blocked for {lag * 1000:.0f} ms")


async def _start_discovery(app):
    app["discovery_task"] = asyncio.create_task(_discovery_broadcaster(app))
    app["transfer_cleanup_task"] = asyncio.create_task(_periodic_transfer_cleanup())
    if os.environ.get("SUPERSHARE_DEBUG_LAG") == "1":
        app["lag_task"] = asyncio.create_task(_loop_lag_monitor())


async def _periodic_transfer_cleanup():
    last_gc = 0
    while True:
        await asyncio.sleep(15)
        with STATE["lock"]:
            changed = _expire_stale_jobs()
            busy = any(j.get("status") == "transferring" for j in STATE.get("transfer_jobs", {}).values())
        if changed or busy:
            request_save()
        if time.time() - last_gc > 3600:
            last_gc = time.time()
            await asyncio.to_thread(cleanup_expired_transfer_jobs)


async def _stop_discovery(app):
    for task_name in ("discovery_task", "transfer_cleanup_task", "lag_task"):
        task = app.get(task_name)
        if not task:
            continue
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


@web.middleware
async def security_headers_middleware(request: web.Request, handler):
    resp = await handler(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    # The in-page PDF preview frames /api/preview from the same origin only.
    frame_policy = "SAMEORIGIN" if request.path == "/api/preview" else "DENY"
    resp.headers.setdefault("X-Frame-Options", frame_policy)
    if request.path == "/" or request.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"
        resp.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; "
            "worker-src 'self' blob:; frame-ancestors 'none'"
        )
    return resp

# ClientConnectionResetError exists in aiohttp >= 3.10; fall back gracefully.
_DISCONNECT_ERRORS = tuple(
    exc for exc in (ConnectionError, getattr(aiohttp, "ClientConnectionResetError", None)) if exc
)


@web.middleware
async def api_error_middleware(request: web.Request, handler):
    try:
        return await handler(request)
    except _DISCONNECT_ERRORS:
        # Client aborted or disconnected mid upload/download/zip stream
        return web.Response(status=499, text="Client Closed Connection")
    except asyncio.CancelledError:
        # aiohttp cancels handlers when the client goes away. Only absorb the
        # cancellation in that case; re-raise otherwise so server shutdown
        # still works.
        transport = request.transport
        if transport is None or transport.is_closing():
            return web.Response(status=499, text="Client Closed Connection")
        raise
    except PermissionError as exc:
        raise web.HTTPForbidden(text=str(exc)) from exc
    except FileNotFoundError as exc:
        raise web.HTTPNotFound(text=str(exc)) from exc


def create_app(port=PORT, tls_info=None) -> web.Application:
    # Streaming is bounded by the request reader and per-chunk file writes.
    app = web.Application(client_max_size=1024 * 1024, handler_args={"max_line_size": 65536, "max_field_size": 65536, "read_bufsize": 1024 * 1024}, middlewares=[api_error_middleware, security_headers_middleware])
    app["port"] = port
    app["scheme"] = "https" if tls_info else "http"
    app["tls_info"] = tls_info or {}
    app.on_startup.append(_start_discovery)
    app.on_cleanup.append(_stop_discovery)

    # Main UI Page & Clean Frontend Routes
    app.router.add_get("/", index_handler)
    for route in ("/send", "/files", "/connect", "/devices", "/activity", "/storage"):
        app.router.add_get(route, index_handler)
    app.router.add_get("/speedtest", speedtest_page_handler)

    # REST & Streaming API
    app.router.add_get("/api/status", status_handler)
    app.router.add_get("/api/network", network_handler)
    app.router.add_get("/api/pairing-qr", pairing_qr_handler)
    app.router.add_get("/api/diagnostics", diagnostics_handler)
    app.router.add_get("/api/speedtest-down", speedtest_down_handler)
    app.router.add_post("/api/speedtest-up", speedtest_up_handler)
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
    app.router.add_post("/api/pick-host-gui", pick_host_gui_handler)
    app.router.add_get("/api/download", download_handler)
    app.router.add_get("/api/preview", preview_file_handler)
    app.router.add_get("/api/zip", zip_folder_handler)
    app.router.add_get("/api/zip-selected", zip_selected_handler)
    app.router.add_get("/api/zip-preflight", zip_preflight_handler)
    app.router.add_post("/api/devices/policy", device_policy_handler)
    app.router.add_post("/api/devices/terminate", device_terminate_handler)
    app.router.add_post("/api/downloads/stop", download_stop_handler)

    app.router.add_post("/api/transfers", create_transfer_handler)
    app.router.add_put("/api/transfers/{job_id}/chunk", transfer_chunk_handler)
    app.router.add_get("/api/transfers/{job_id}", transfer_status_handler)
    app.router.add_post("/api/transfers/{job_id}/complete", complete_transfer_handler)
    app.router.add_post("/api/transfers/{job_id}/cancel", cancel_transfer_handler)
    app.router.add_post("/api/mkdir", mkdir_handler)
    app.router.add_post("/api/delete-selected", delete_selected_handler)
    app.router.add_post("/api/set-share-dir", set_share_dir_handler)
    app.router.add_get("/api/storage-info", storage_info_handler)
    app.router.add_post("/api/clear-history", clear_history_handler)
    app.router.add_post("/api/clear-partials", clear_partials_handler)
    app.router.add_post("/api/reset-state", reset_state_handler)

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
