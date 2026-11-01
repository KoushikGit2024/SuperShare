"""
routes_system.py — Network status, diagnostics, storage maintenance, speedtest, and state resets.
"""

import asyncio
import os
import shutil
import time

from aiohttp import web

from .config import (
    STATE,
    CHUNK_SIZE,
    ACTIVE_SLOT_STATES,
    STALE_TRANSFER_SECONDS,
    save_persistent_state,
    request_save,
)
from .routes_common import *
from .routes_common import (
    STALE_PARTIAL_SECONDS,
    _require_host_dashboard,
    _require_share_access,
    _authorize_transfer_write,
    _host_interfaces,
    _host_addresses,
    _connection_kind,
    _request_ip,
)

_SPEEDTEST_BLOCK = bytes(1024 * 1024)
_storage_cache = {"root": None, "at": 0.0, "scan": (0, 0, 0, 0, 0, 0)}


def _is_port_80_proxy_active() -> bool:
    try:
        import subprocess

        proc = subprocess.run(
            ["netsh", "interface", "portproxy", "show", "v4tov4"],
            capture_output=True,
            text=True,
            check=False,
        )
        for line in proc.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 4 and "80" in parts:
                return True
    except Exception:
        pass
    return False


async def network_handler(request: web.Request) -> web.Response:
    interfaces = _host_interfaces()
    connection = None
    if interfaces:
        selected = interfaces[0]
        port = request.url.port or 80
        scheme = request.scheme
        has_proxy = _is_port_80_proxy_active() if port != 80 else True
        port_part = "" if (port in (80, 443) or has_proxy) else f":{port}"
        connection = {
            "name": selected["name"],
            "kind": selected.get("kind", "Local network"),
            "address": selected["address"],
            "url": f"{scheme}://{selected['address']}{port_part}/",
        }
    return web.json_response(
        {
            "service": "SuperShare",
            "protocol_version": 1,
            "port": request.url.port or 80,
            "scheme": request.scheme,
            "ca_fingerprint": request.app.get("tls_info", {}).get("ca_fingerprint"),
            "addresses": [connection["address"]] if connection else [],
            "interfaces": interfaces,
            "connection": connection,
            "connection_path": "/",
            "pairing_required": False,
            "internet_required": False,
        }
    )


async def diagnostics_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    root = STATE["share_dir"]
    try:
        usage = shutil.disk_usage(root)
        with STATE["lock"]:
            active_jobs = [
                job
                for job in STATE.get("transfer_jobs", {}).values()
                if job.get("status") in {"queued", "transferring", "interrupted", "verifying"}
            ]
            reserved_bytes = sum(
                max(0, job.get("size", 0) - job.get("offset", 0)) for job in active_jobs
            )
        storage = {
            "available_bytes": usage.free,
            "reserved_bytes": reserved_bytes,
            "active_transfer_count": len(active_jobs),
            "total_bytes": usage.total,
        }
    except OSError as exc:
        storage = {"error": str(exc)}
    return web.json_response(
        {
            "service": "online",
            "protocol_version": 1,
            "port": request.url.port or 80,
            "addresses": _host_addresses(),
            "interfaces": _host_interfaces(),
            "receive_root": root,
            "storage": storage,
            "pairing_code_rotates_on_restart": True,
        }
    )


def _scan_share(root):
    shared_bytes = shared_count = part_bytes = part_count = stale_bytes = stale_count = 0
    now = time.time()
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            try:
                st = os.stat(os.path.join(dirpath, name))
            except OSError:
                continue
            if name.startswith(".supershare-") and name.endswith(".partial"):
                part_count += 1
                part_bytes += st.st_size
                if now - st.st_mtime > STALE_PARTIAL_SECONDS:
                    stale_count += 1
                    stale_bytes += st.st_size
            else:
                shared_count += 1
                shared_bytes += st.st_size
    return shared_bytes, shared_count, part_bytes, part_count, stale_bytes, stale_count


_storage_cache = {"root": None, "at": 0.0, "scan": (0, 0, 0, 0, 0, 0)}


async def storage_info_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    root = STATE["share_dir"]
    try:
        usage = await asyncio.to_thread(shutil.disk_usage, root)
        total, free, used = usage.total, usage.free, usage.used
    except OSError:
        total = free = used = 0
    if _storage_cache["root"] != root or time.monotonic() - _storage_cache["at"] > 20:
        scan_res = await asyncio.to_thread(_scan_share, root)
        _storage_cache.update(root=root, at=time.monotonic(), scan=scan_res)
    sb, sc, pb, pc, stale_b, stale_c = _storage_cache["scan"]
    with STATE["lock"]:
        devices_count, transfers_count = len(STATE["devices"]), len(STATE["transfers"])
    return web.json_response(
        {
            "share_dir": root,
            "disk_total": total,
            "disk_free": free,
            "disk_used": used,
            "shared_files_bytes": sb,
            "shared_files_count": sc,
            "partial_bytes": pb,
            "partial_count": pc,
            "stale_partial_bytes": stale_b,
            "stale_partial_count": stale_c,
            "stale_after_hours": 24,
            "low_space": bool(total) and free < max(1 << 30, int(total * 0.05)),
            "devices_count": devices_count,
            "transfers_count": transfers_count,
        }
    )


async def clear_history_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    from .config import clear_transfers_history

    clear_transfers_history()
    return web.json_response({"status": "ok", "message": "Transfer history cleared"})


async def clear_partials_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    from .config import clear_temp_partials

    body = {}
    if request.can_read_body:
        try:
            body = await request.json()
        except Exception:
            body = {}
    try:
        hours = float(body.get("older_than_hours", 0)) if isinstance(body, dict) else 0
    except (TypeError, ValueError):
        raise web.HTTPBadRequest(text="older_than_hours must be a number")
    res = await asyncio.to_thread(clear_temp_partials, max(0, hours) * 3600)
    _storage_cache["at"] = 0.0
    return web.json_response(
        {"status": "ok", "removed": res["removed"], "reclaimed_bytes": res["reclaimed_bytes"]}
    )


async def reset_state_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    from .config import reset_all_stored_state

    try:
        reset_all_stored_state()
    except RuntimeError as exc:
        raise web.HTTPConflict(text=str(exc))
    return web.json_response({"status": "ok", "message": "All devices and database history reset"})


_SPEEDTEST_BLOCK = bytes(1024 * 1024)


async def speedtest_down_handler(request: web.Request) -> web.StreamResponse:
    _require_share_access(request, "read")
    try:
        mb = max(1, min(512, int(request.query.get("mb", "64"))))
    except ValueError:
        raise web.HTTPBadRequest(text="mb must be an integer")
    resp = web.StreamResponse(
        headers={
            "Content-Type": "application/octet-stream",
            "Content-Length": str(mb * 1024 * 1024),
            "Cache-Control": "no-store",
        }
    )
    await resp.prepare(request)
    for _ in range(mb):
        await resp.write(_SPEEDTEST_BLOCK)
    await resp.write_eof()
    return resp


async def speedtest_up_handler(request: web.Request) -> web.Response:
    _authorize_transfer_write(request)
    started = time.perf_counter()
    received = 0
    limit = 512 * 1024 * 1024
    async for piece in request.content.iter_chunked(1024 * 1024):
        received += len(piece)
        if received > limit:
            raise web.HTTPRequestEntityTooLarge(max_size=limit, actual_size=received)
    return web.json_response(
        {"bytes": received, "server_seconds": round(time.perf_counter() - started, 3)}
    )
