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
from aiohttp import web

from .config import STATE, CHUNK_SIZE, PAIRING_CODE, save_persistent_state, record_transfer
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
        "transfers": STATE["transfers"][-50:] if local_request else [],
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
    _touch_device(device_id, str(body.get("name", "Unknown device")), str(body.get("type", "Device")), request.remote)
    with STATE["lock"]:
        device = STATE["devices"][device_id]
        device["token_hash"] = hashlib.sha256(token.encode("utf-8")).hexdigest()
        device["trusted"] = False
        device["permissions"] = {"read": False, "write": False}
        device.pop("approved_until", None)
    save_persistent_state()
    _device_persisted_at[device_id] = time.monotonic()
    response = web.json_response({"status": "paired", "device_id": device_id})
    response.set_cookie("supershare_token", token, httponly=True, samesite="Strict", path="/api", max_age=31536000)
    return response


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
    return web.json_response({"devices": _public_devices(), "transfers": STATE["transfers"][-50:]})


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
