"""
api_routes.py — aiohttp REST and streaming endpoints for SuperShare.
"""
import os
import json
import asyncio
import urllib.parse
import re
import time
import uuid
import ipaddress
import hashlib
import hmac
import secrets
import socket
import shutil
from aiohttp import web

from .config import STATE, CHUNK_SIZE, MAX_CONCURRENT_TRANSFERS, PAIRING_CODE, save_persistent_state, record_transfer
from .file_manager import (
    safe_join,
    list_directory,
    list_host_folders,
    build_folder_zip,
    build_multi_selection_zip,
    delete_selected_items,
)

_pair_attempts = {}
_device_persisted_at = {}
_PAIRING_WORDS = ("amber", "birch", "cobalt", "delta", "ember", "fern", "granite", "harbor",
                  "indigo", "juniper", "kepler", "linen", "maple", "north", "onyx", "pepper",
                  "quartz", "river", "silver", "timber", "umber", "violet", "willow", "xenon",
                  "yellow", "zephyr")


def _public_transfers(limit=50):
    with STATE["lock"]:
        items = list(STATE["transfers"])
        for job in STATE.get("transfer_jobs", {}).values():
            if job.get("status") != "completed":
                items.append({"id": job.get("id"), "device_id": job.get("device_id"), "filename": job.get("filename"),
                              "size": job.get("size"), "offset": job.get("offset"), "status": job.get("status"),
                              "timestamp": job.get("created_at"), "updated_at": job.get("updated_at"),
                              "destination": job.get("destination"), "detail": job.get("error", "")})
        return sorted(items, key=lambda item: item.get("timestamp", item.get("updated_at", 0)))[-limit:]


def _host_addresses():
    addresses = set()
    try:
        for result in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET, socket.SOCK_STREAM):
            address = result[4][0]
            if not address.startswith("127."):
                addresses.add(address)
    except OSError:
        pass
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("192.0.2.1", 9))
            address = probe.getsockname()[0]
            if address and not address.startswith("127."):
                addresses.add(address)
        finally:
            probe.close()
    except OSError:
        pass
    return sorted(addresses, key=lambda address: (not address.startswith("192.168.137."), address))


async def network_handler(request: web.Request) -> web.Response:
    return web.json_response({
        "service": "SuperShare",
        "protocol_version": 1,
        "port": request.url.port or 80,
        "addresses": _host_addresses(),
        "connection_path": "/",
        "pairing_required": True,
        "internet_required": False,
    })


async def diagnostics_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    root = STATE["share_dir"]
    try:
        usage = shutil.disk_usage(root)
        storage = {"available_bytes": usage.free, "total_bytes": usage.total}
    except OSError as exc:
        storage = {"error": str(exc)}
    return web.json_response({"service": "online", "protocol_version": 1, "port": request.url.port or 80,
                              "addresses": _host_addresses(), "receive_root": root, "storage": storage,
                              "pairing_code_rotates_on_restart": True})


async def status_handler(request: web.Request) -> web.Response:
    device_id = request.headers.get("X-SuperShare-Device", "").strip()
    local_request = _is_local_host_request(request)
    with STATE["lock"]:
        existing = STATE["devices"].get(device_id, {})
        may_update_identity = local_request or not existing.get("token_hash") or _authenticated_device(request, existing)
    if device_id and may_update_identity:
        _touch_device(device_id, request.headers.get("X-SuperShare-Name", "Unknown device"),
                      request.headers.get("X-SuperShare-Type", "Device"), request.remote)
    if local_request and device_id:
        changed = False
        with STATE["lock"]:
            device = STATE["devices"].get(device_id)
            if device:
                changed = not device.get("trusted") or not device.get("token_hash")
                device["trusted"] = True
                device["token_hash"] = device.get("token_hash") or hashlib.sha256(secrets.token_bytes(32)).hexdigest()
        if changed:
            save_persistent_state()
            _device_persisted_at[device_id] = time.monotonic()
    if local_request:
        can_view = True
    elif device_id:
        with STATE["lock"]:
            device = STATE["devices"].get(device_id, {})
            approved = device.get("trusted", False) or device.get("approved_until", 0) > int(time.time())
            permissions = device.get("permissions", {})
            can_view = (_authenticated_device(request, device) and approved
                        and (permissions.get("read", False) or permissions.get("write", False)))
    else:
        can_view = False
    return web.json_response({
        "status": "online",
        "server": "SuperShare",
        "share_root": STATE["share_dir"] if can_view else None,
        "host_name": os.environ.get("COMPUTERNAME") or (os.uname().nodename if hasattr(os, "uname") else "SuperShare host"),
        "host_dashboard": local_request,
        "devices": _public_devices() if local_request else [],
        "transfers": _public_transfers() if local_request else [],
    })


async def upload_permission_handler(request: web.Request) -> web.Response:
    device_id = request.headers.get("X-SuperShare-Device", "").strip()
    if not device_id:
        raise web.HTTPBadRequest(text="Device identity is required")
    local_request = _is_local_host_request(request)
    with STATE["lock"]:
        existing = STATE["devices"].get(device_id, {})
        paired = _authenticated_device(request, existing)
        may_update_identity = local_request or not existing.get("token_hash") or paired
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", device_id):
        raise web.HTTPBadRequest(text="Invalid device identity")
    if may_update_identity:
        _touch_device(device_id, request.headers.get("X-SuperShare-Name", "Unknown device"),
                      request.headers.get("X-SuperShare-Type", "Device"), request.remote)
    if local_request:
        return web.json_response({"allowed": True, "approved": True, "paired": True,
                                  "permissions": {"read": True, "write": True}, "message": "Ready to send to this host"})
    with STATE["lock"]:
        device = STATE["devices"].get(device_id, {})
        paired = _authenticated_device(request, device)
        approved = paired and (device.get("trusted", False) or device.get("approved_until", 0) > int(time.time()))
        permissions = device.get("permissions", {})
        allowed = approved and permissions.get("write", False)
        readable = approved and permissions.get("read", False)
    message = "Ready to send" if allowed else "Host granted read-only access" if readable else "Waiting for host approval" if paired else "Pair with the host first"
    return web.json_response({"allowed": allowed, "approved": approved, "paired": paired,
                              "pair_confirmed": bool(device.get("pair_confirmed", False)) if paired else False,
                              "verification_phrase": device.get("verification_phrase") if paired else None,
                              "permissions": permissions, "device_id": device_id, "message": message})


async def pair_device_handler(request: web.Request) -> web.Response:
    body = await request.json()
    peer = request.remote or "unknown"
    now = time.monotonic()
    attempts = [stamp for stamp in _pair_attempts.get(peer, []) if now - stamp < 60]
    if len(attempts) >= 6:
        _pair_attempts[peer] = attempts
        raise web.HTTPTooManyRequests(text="Too many pairing attempts; wait one minute")
    attempts.append(now)
    _pair_attempts[peer] = attempts
    if not hmac.compare_digest(str(body.get("code", "")), PAIRING_CODE):
        raise web.HTTPForbidden(text="Pairing code is incorrect or expired")
    _pair_attempts.pop(peer, None)
    device_id = str(body.get("id", ""))
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", device_id):
        raise web.HTTPBadRequest(text="Invalid device identity")
    token = secrets.token_urlsafe(32)
    phrase = " ".join(secrets.choice(_PAIRING_WORDS) for _ in range(3))
    _touch_device(device_id, str(body.get("name", "Unknown device")), str(body.get("type", "Device")), request.remote)
    with STATE["lock"]:
        device = STATE["devices"][device_id]
        device["token_hash"] = hashlib.sha256(token.encode("utf-8")).hexdigest()
        device["trusted"] = False
        device["permissions"] = {"read": False, "write": False}
        device["pair_confirmed"] = False
        device["verification_phrase"] = phrase
        device.pop("approved_until", None)
    save_persistent_state()
    _device_persisted_at[device_id] = time.monotonic()
    response = web.json_response({"status": "paired", "device_id": device_id, "verification_phrase": phrase})
    response.set_cookie("supershare_token", token, httponly=True, samesite="Strict", path="/api", max_age=31536000)
    return response


async def confirm_pairing_handler(request: web.Request) -> web.Response:
    device_id = request.headers.get("X-SuperShare-Device", "").strip()
    with STATE["lock"]:
        device = STATE["devices"].get(device_id, {})
        if not _authenticated_device(request, device):
            raise web.HTTPForbidden(text="This device is not paired")
        device["pair_confirmed"] = True
    save_persistent_state()
    return web.json_response({"status": "confirmed"})


def _touch_device(device_id, name, device_type, remote):
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", device_id):
        return
    now = int(time.time())
    persist = False
    with STATE["lock"]:
        old = STATE["devices"].get(device_id, {})
        persist = (not old or old.get("name") != old.get("display_name", (name or "Unknown device")[:80])
                   or old.get("type") != (device_type or "Device")[:40]
                   or old.get("ip") != (remote or old.get("ip", ""))
                   or time.monotonic() - _device_persisted_at.get(device_id, 0) >= 60)
        STATE["devices"][device_id] = {
            "id": device_id,
            "name": old.get("display_name", (name or "Unknown device")[:80]),
            "display_name": old.get("display_name", ""),
            "type": (device_type or "Device")[:40],
            "ip": remote or old.get("ip", ""),
            "first_seen": old.get("first_seen", int(time.time())),
            "last_seen": now,
            "online": True,
            "trusted": old.get("trusted", False),
            "approved_until": old.get("approved_until", 0),
            "token_hash": old.get("token_hash", ""),
            "permissions": old.get("permissions", {"read": False, "write": False}),
            "pair_confirmed": old.get("pair_confirmed", False),
            "verification_phrase": old.get("verification_phrase", ""),
        }
    if persist:
        save_persistent_state()
        _device_persisted_at[device_id] = time.monotonic()


def _public_devices():
    now = int(time.time())
    with STATE["lock"]:
        result = []
        for device in STATE["devices"].values():
            item = dict(device)
            item["paired"] = bool(item.get("token_hash"))
            item["pair_confirmed"] = bool(item.get("pair_confirmed", False))
            item.pop("token_hash", None)
            item["online"] = now - item.get("last_seen", 0) < 25
            result.append(item)
        return sorted(result, key=lambda d: (not d["online"], d["name"].lower()))


def _is_local_host_request(request):
    try:
        return ipaddress.ip_address(request.remote or "").is_loopback
    except ValueError:
        return False


def _require_host_dashboard(request):
    if not _is_local_host_request(request):
        raise web.HTTPForbidden(text="This host control is available from the laptop dashboard only")


def _require_share_access(request, permission="read"):
    if _is_local_host_request(request):
        return
    device_id = request.headers.get("X-SuperShare-Device", "").strip()
    with STATE["lock"]:
        device = STATE["devices"].get(device_id, {})
        approved = (_authenticated_device(request, device)
                    and (device.get("trusted", False) or device.get("approved_until", 0) > int(time.time()))
                    and device.get("permissions", {}).get(permission, False))
    if not approved:
        raise web.HTTPForbidden(text=f"Pair this device and get host {permission} permission to access shared files")


def _authenticated_device(request, device):
    authorization = request.headers.get("Authorization", "")
    token = authorization[7:] if authorization.startswith("Bearer ") else request.cookies.get("supershare_token", "")
    saved_hash = device.get("token_hash", "")
    if not token or not saved_hash:
        return False
    supplied_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    return hmac.compare_digest(supplied_hash, saved_hash)


async def devices_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    return web.json_response({"devices": _public_devices(), "transfers": _public_transfers()})


async def rename_device_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    body = await request.json()
    device_id = body.get("id", "")
    name = str(body.get("name", "")).strip()[:80]
    with STATE["lock"]:
        device = STATE["devices"].get(device_id)
        if not device or not name:
            raise web.HTTPBadRequest(text="Device and non-empty name are required")
        device["name"] = name
        device["display_name"] = name
    save_persistent_state()
    return web.json_response({"status": "ok"})


async def forget_device_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    body = await request.json()
    with STATE["lock"]:
        STATE["devices"].pop(body.get("id", ""), None)
    save_persistent_state()
    return web.json_response({"status": "ok"})


async def revoke_device_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    body = await request.json()
    with STATE["lock"]:
        device = STATE["devices"].get(body.get("id", ""))
        if not device:
            raise web.HTTPNotFound(text="Device not found")
        device["trusted"] = False
        device["approved_until"] = 0
        device["permissions"] = {"read": False, "write": False}
    save_persistent_state()
    return web.json_response({"status": "ok"})


async def approve_device_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    body = await request.json()
    with STATE["lock"]:
        device = STATE["devices"].get(body.get("id", ""))
        if not device:
            raise web.HTTPNotFound(text="Device not found")
        if not device.get("token_hash"):
            raise web.HTTPConflict(text="Pair this device before granting access")
        if not device.get("pair_confirmed"):
            raise web.HTTPConflict(text="Confirm that the verification phrase matches before granting access")
        requested = body.get("permissions", {"read": True, "write": True})
        if not isinstance(requested, dict):
            raise web.HTTPBadRequest(text="Permissions must be an object")
        device["permissions"] = {"read": bool(requested.get("read")), "write": bool(requested.get("write"))}
        if body.get("remember"):
            device["trusted"] = True
            device.pop("approved_until", None)
        else:
            device["trusted"] = False
            device["approved_until"] = int(time.time()) + 15 * 60
    save_persistent_state()
    return web.json_response({"status": "ok"})


async def list_files_handler(request: web.Request) -> web.Response:
    _require_share_access(request)
    rel_path = request.query.get("path", "")
    share_dir = STATE["share_dir"]
    items = await asyncio.to_thread(list_directory, share_dir, rel_path)
    return web.json_response({
        "share_root": share_dir,
        "current_path": rel_path,
        "items": items
    })


async def host_folders_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    target_dir = request.query.get("dir", STATE["share_dir"])
    data = await asyncio.to_thread(list_host_folders, target_dir)
    return web.json_response(data)


def _open_tk_folder_picker(initial_dir: str) -> str:
    import tkinter as tk
    from tkinter import filedialog
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    selected = filedialog.askdirectory(
        initialdir=initial_dir,
        title="SuperShare - Select Any Folder or Drive on Host PC"
    )
    root.destroy()
    return selected


async def pick_host_gui_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    try:
        selected = await asyncio.to_thread(_open_tk_folder_picker, STATE["share_dir"])
        if selected and os.path.isdir(selected):
            STATE["share_dir"] = os.path.abspath(selected)
            save_persistent_state()
            print(f"[FOLDER] Active shared folder switched to: {STATE['share_dir']}")
        return web.json_response({"status": "ok", "share_root": STATE["share_dir"]})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=400)


async def set_share_dir_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    body = await request.json()
    new_dir = body.get("share_dir", "").strip()
    if not new_dir or not os.path.isdir(new_dir):
        return web.json_response({"status": "error", "message": "Invalid directory path"}, status=400)
    STATE["share_dir"] = os.path.abspath(new_dir)
    save_persistent_state()
    print(f"[FOLDER] Active shared folder switched to: {STATE['share_dir']}")
    return web.json_response({"status": "ok", "share_root": STATE["share_dir"]})


async def mkdir_handler(request: web.Request) -> web.Response:
    _require_share_access(request, "write")
    body = await request.json()
    rel_path = body.get("path", "")
    target = safe_join(STATE["share_dir"], rel_path)
    os.makedirs(target, exist_ok=True)
    return web.json_response({"status": "ok"})


async def delete_selected_handler(request: web.Request) -> web.Response:
    _require_share_access(request, "write")
    body = await request.json()
    items = body.get("items", [])
    deleted = await asyncio.to_thread(delete_selected_items, STATE["share_dir"], items)
    print(f"[DELETE] Removed {deleted} item(s)")
    return web.json_response({"status": "ok", "deleted": deleted})


async def download_handler(request: web.Request) -> web.StreamResponse:
    _require_share_access(request)
    rel_path = request.query.get("path", "")
    target = safe_join(STATE["share_dir"], rel_path)
    if not os.path.isfile(target):
        raise web.HTTPNotFound(text="File not found")

    filename = os.path.basename(target)
    return web.FileResponse(
        path=target,
        chunk_size=CHUNK_SIZE,
        headers={
            "Content-Disposition": f'attachment; filename="{urllib.parse.quote(filename)}"'
        }
    )


async def _stream_and_remove_zip(request: web.Request, tmp_zip: str, zip_filename: str) -> web.StreamResponse:
    try:
        zip_size = os.path.getsize(tmp_zip)
        resp = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "application/zip",
                "Content-Disposition": f'attachment; filename="{urllib.parse.quote(zip_filename)}"',
                "Content-Length": str(zip_size),
            }
        )
        await resp.prepare(request)
        with open(tmp_zip, "rb") as f:
            while True:
                chunk = await asyncio.to_thread(f.read, CHUNK_SIZE)
                if not chunk:
                    break
                await resp.write(chunk)
        await resp.write_eof()
        return resp
    finally:
        if os.path.exists(tmp_zip):
            try:
                os.remove(tmp_zip)
            except Exception:
                pass


async def zip_folder_handler(request: web.Request) -> web.StreamResponse:
    _require_share_access(request)
    rel_path = request.query.get("path", "")
    tmp_zip, zip_filename = await asyncio.to_thread(build_folder_zip, STATE["share_dir"], rel_path)
    return await _stream_and_remove_zip(request, tmp_zip, zip_filename)


async def zip_selected_handler(request: web.Request) -> web.StreamResponse:
    _require_share_access(request)
    items_raw = request.query.get("items", "[]")
    rel_paths = json.loads(items_raw)
    tmp_zip, zip_filename = await asyncio.to_thread(build_multi_selection_zip, STATE["share_dir"], rel_paths)
    return await _stream_and_remove_zip(request, tmp_zip, zip_filename)


async def upload_handler(request: web.Request) -> web.Response:
    raw_rel = request.headers.get("X-File-Path", "uploaded_file.bin")
    rel_path = urllib.parse.unquote(raw_rel)
    device_id = request.headers.get("X-SuperShare-Device", "").strip()
    if not device_id or not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", device_id):
        raise web.HTTPForbidden(text="A registered device identity is required")
    local_request = _is_local_host_request(request)
    with STATE["lock"]:
        existing = STATE["devices"].get(device_id, {})
        paired = local_request or _authenticated_device(request, existing)
    if existing.get("token_hash") and not paired:
        raise web.HTTPForbidden(text="This request does not match the paired device")
    _touch_device(device_id, request.headers.get("X-SuperShare-Name", "Unknown device"),
                  request.headers.get("X-SuperShare-Type", "Device"), request.remote)
    with STATE["lock"]:
        device = STATE["devices"].get(device_id, {})
        paired = local_request or _authenticated_device(request, device)
        approved = local_request or (paired and (device.get("trusted", False) or device.get("approved_until", 0) > int(time.time())))
        write_allowed = local_request or device.get("permissions", {}).get("write", False)
    if not paired:
        raise web.HTTPForbidden(text="Pair this device with the host before uploading")
    if not approved or not write_allowed:
        raise web.HTTPForbidden(text="This device needs host send permission before uploading")

    target = safe_join(STATE["share_dir"], rel_path)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    if os.path.exists(target):
        record_transfer(device_id, os.path.basename(target), 0, "failed", "Destination already exists", target)
        raise web.HTTPConflict(text="A file already exists at this destination")
    temp_path = os.path.join(os.path.dirname(target), f".supershare-{uuid.uuid4().hex}.partial")
    print(f"[UPLOAD] Receiving -> {rel_path}")
    received = 0
    try:
        with open(temp_path, "xb") as f:
            async for chunk in request.content.iter_chunked(CHUNK_SIZE):
                await asyncio.to_thread(f.write, chunk)
                received += len(chunk)
            await asyncio.to_thread(f.flush)
            await asyncio.to_thread(os.fsync, f.fileno())
        # A hard-link publication fails atomically if a competing upload created
        # the final name; this preserves the existing file without overwrite.
        await asyncio.to_thread(os.link, temp_path, target)
        os.remove(temp_path)
    except Exception as exc:
        try:
            if os.path.exists(temp_path):
                os.remove(temp_path)
        except OSError:
            pass
        record_transfer(device_id, os.path.basename(target), received, "failed", str(exc)[:200], target)
        if isinstance(exc, FileExistsError):
            raise web.HTTPConflict(text="A file already exists at this destination") from exc
        raise
    print(f"[SAVED]  {target}")
    record_transfer(device_id, os.path.basename(target), received, destination=target)
    return web.json_response({"status": "ok", "bytes": received})


def _authorize_transfer_write(request):
    device_id = request.headers.get("X-SuperShare-Device", "").strip()
    local_request = _is_local_host_request(request)
    with STATE["lock"]:
        device = STATE["devices"].get(device_id, {})
        allowed = local_request or (
            _authenticated_device(request, device)
            and (device.get("trusted") or device.get("approved_until", 0) > int(time.time()))
            and device.get("permissions", {}).get("write", False)
        )
    if not allowed:
        raise web.HTTPForbidden(text="This device needs host send permission before uploading")
    return device_id


async def create_transfer_handler(request: web.Request) -> web.Response:
    device_id = _authorize_transfer_write(request)
    try:
        body = await request.json()
        name = str(body.get("name", "")).strip()
        size = int(body.get("size", -1))
        destination = str(body.get("path", name))
        resume_id = str(body.get("resume_id", ""))
        collision = str(body.get("collision", "ask"))
    except (ValueError, TypeError):
        raise web.HTTPBadRequest(text="Invalid transfer details")
    if not name or size < 0 or size > 100 * 1024**3:
        raise web.HTTPBadRequest(text="A filename and size up to 100 GB are required")
    try:
        if shutil.disk_usage(STATE["share_dir"]).free < size:
            raise web.HTTPInsufficientStorage(text="Not enough free space on the selected receive drive")
    except OSError:
        raise web.HTTPInsufficientStorage(text="The selected receive drive is unavailable")
    target = safe_join(STATE["share_dir"], destination)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    if resume_id:
        with STATE["lock"]:
            existing_job = STATE.get("transfer_jobs", {}).get(resume_id)
            if (existing_job and existing_job.get("device_id") == device_id and existing_job.get("size") == size
                    and existing_job.get("destination") == target and existing_job.get("status") in {"queued", "transferring", "interrupted"}):
                if os.path.exists(existing_job["part_path"]):
                    with open(existing_job["part_path"], "r+b") as partial:
                        partial.truncate(existing_job["offset"])
                existing_job["status"] = "interrupted"
                existing_job["updated_at"] = int(time.time())
                save_persistent_state()
                return web.json_response({"id": resume_id, "offset": existing_job["offset"], "chunk_size": CHUNK_SIZE, "status": "interrupted"})
            if (existing_job and existing_job.get("device_id") == device_id and existing_job.get("size") == size
                    and existing_job.get("destination") == target and existing_job.get("status") == "failed"
                    and not os.path.exists(target) and os.path.exists(existing_job.get("part_path", ""))):
                with open(existing_job["part_path"], "r+b") as partial:
                    partial.truncate(0)
                existing_job["offset"] = 0
                existing_job["chunk_hashes"] = []
                existing_job["status"] = "queued"
                existing_job["updated_at"] = int(time.time())
                existing_job.pop("error", None)
                save_persistent_state()
                return web.json_response({"id": resume_id, "offset": 0, "chunk_size": CHUNK_SIZE, "status": "queued"})
    if collision not in {"ask", "skip", "rename", "replace"}:
        raise web.HTTPBadRequest(text="Collision choice must be ask, skip, rename, or replace")
    if os.path.exists(target):
        if collision == "ask":
            return web.json_response({"error": "destination_exists", "filename": os.path.basename(target), "choices": ["skip", "rename", "replace", "cancel"]}, status=409)
        if collision == "skip":
            return web.json_response({"status": "skipped", "filename": os.path.basename(target)})
        if collision == "rename":
            stem, extension = os.path.splitext(target)
            suffix = 1
            while os.path.exists(f"{stem} ({suffix}){extension}"):
                suffix += 1
            target = f"{stem} ({suffix}){extension}"
    with STATE["lock"]:
        active_jobs = [job for job in STATE.get("transfer_jobs", {}).values() if job.get("status") in {"queued", "transferring", "interrupted", "verifying"}]
        if len(active_jobs) >= MAX_CONCURRENT_TRANSFERS or sum(job.get("device_id") == device_id for job in active_jobs) >= MAX_CONCURRENT_TRANSFERS:
            raise web.HTTPTooManyRequests(text=f"Transfer limit reached ({MAX_CONCURRENT_TRANSFERS} active jobs). Wait for one to finish.")
    job_id = uuid.uuid4().hex
    part_path = os.path.join(os.path.dirname(target), f".supershare-{job_id}.partial")
    job = {"id": job_id, "device_id": device_id, "filename": os.path.basename(target),
           "destination": target, "part_path": part_path, "size": size, "offset": 0,
           "collision": collision,
           "status": "queued", "created_at": int(time.time()), "updated_at": int(time.time()),
           "chunk_hashes": []}
    if size == 0:
        open(part_path, "xb").close()
    with STATE["lock"]:
        STATE.setdefault("transfer_jobs", {})[job_id] = job
    save_persistent_state()
    return web.json_response({"id": job_id, "offset": 0, "chunk_size": CHUNK_SIZE, "status": job["status"]}, status=201)


def _get_transfer_job(request, job_id):
    device_id = _authorize_transfer_write(request)
    with STATE["lock"]:
        job = STATE.get("transfer_jobs", {}).get(job_id)
        if not job or (not _is_local_host_request(request) and job.get("device_id") != device_id):
            raise web.HTTPNotFound(text="Transfer session not found")
        return job


async def transfer_chunk_handler(request: web.Request) -> web.Response:
    job = _get_transfer_job(request, request.match_info["job_id"])
    try:
        offset = int(request.headers.get("X-Chunk-Offset", "-1"))
    except ValueError:
        raise web.HTTPBadRequest(text="Invalid chunk offset")
    chunk = await request.read()
    supplied_hash = request.headers.get("X-Chunk-SHA256", "").lower()
    actual_hash = hashlib.sha256(chunk).hexdigest()
    if not re.fullmatch(r"[a-f0-9]{64}", supplied_hash) or not hmac.compare_digest(actual_hash, supplied_hash):
        raise web.HTTPUnprocessableEntity(text="Chunk SHA-256 mismatch; resend this chunk")
    if not chunk or len(chunk) > CHUNK_SIZE:
        raise web.HTTPBadRequest(text="Chunk size is invalid")
    with STATE["lock"]:
        if job["status"] not in {"queued", "transferring", "interrupted"}:
            raise web.HTTPConflict(text=f"Transfer is {job['status']}")
        if offset != job["offset"]:
            return web.json_response({"error": "offset_mismatch", "expected_offset": job["offset"]}, status=409)
        if offset + len(chunk) > job["size"]:
            raise web.HTTPBadRequest(text="Chunk exceeds the declared file size")
        with open(job["part_path"], "ab" if offset else "wb") as output:
            output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        job["offset"] += len(chunk)
        job["status"] = "transferring"
        job["chunk_hashes"].append(actual_hash)
        job["updated_at"] = int(time.time())
        save_persistent_state()
        return web.json_response({"offset": job["offset"], "status": job["status"]})


async def transfer_status_handler(request: web.Request) -> web.Response:
    job = _get_transfer_job(request, request.match_info["job_id"])
    return web.json_response({key: job[key] for key in ("id", "filename", "destination", "size", "offset", "status", "updated_at")})


async def complete_transfer_handler(request: web.Request) -> web.Response:
    job = _get_transfer_job(request, request.match_info["job_id"])
    with STATE["lock"]:
        if job["offset"] != job["size"]:
            raise web.HTTPConflict(text="Transfer is incomplete; resume from the acknowledged offset")
        if job["status"] not in {"queued", "transferring", "interrupted"}:
            raise web.HTTPConflict(text=f"Transfer is {job['status']}")
        job["status"] = "verifying"
        job["updated_at"] = int(time.time())
        save_persistent_state()
    body = await request.json()
    expected = str(body.get("sha256", "")).lower()
    if expected and not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise web.HTTPBadRequest(text="Invalid SHA-256 checksum")
    digest = hashlib.sha256()
    with open(job["part_path"], "rb") as source:
        while True:
            chunk = await asyncio.to_thread(source.read, CHUNK_SIZE)
            if not chunk:
                break
            digest.update(chunk)
    actual_digest = digest.hexdigest()
    if expected and not hmac.compare_digest(actual_digest, expected):
        job["status"] = "failed"
        job["error"] = "SHA-256 checksum mismatch"
        job["updated_at"] = int(time.time())
        save_persistent_state()
        raise web.HTTPUnprocessableEntity(text="SHA-256 checksum mismatch; retry this transfer")
    if os.path.exists(job["destination"]) and job.get("collision") != "replace":
        job["status"] = "failed"
        job["error"] = "Destination already exists"
        save_persistent_state()
        raise web.HTTPConflict(text="A file already exists at this destination")
    if job.get("collision") == "replace":
        os.replace(job["part_path"], job["destination"])
    else:
        os.link(job["part_path"], job["destination"])
    os.remove(job["part_path"])
    job["status"] = "completed"
    job["sha256"] = actual_digest
    job["updated_at"] = int(time.time())
    record_transfer(job["device_id"], job["filename"], job["size"], detail=f"SHA-256 {actual_digest}", destination=job["destination"])
    save_persistent_state()
    return web.json_response({"status": "completed", "sha256": actual_digest})


async def cancel_transfer_handler(request: web.Request) -> web.Response:
    job = _get_transfer_job(request, request.match_info["job_id"])
    with STATE["lock"]:
        if job["status"] in {"completed", "cancelled", "verifying"}:
            raise web.HTTPConflict(text=f"Transfer is {job['status']}")
        try:
            os.remove(job["part_path"])
        except FileNotFoundError:
            pass
        job["status"] = "cancelled"
        job["updated_at"] = int(time.time())
        save_persistent_state()
    return web.json_response({"status": "cancelled"})
