"""
routes_devices.py — Device pairing, profile tracking, permissions, policies, and heartbeat handlers.
"""
import asyncio
import hashlib
import hmac
import io
import json
import os
import re
import time
import urllib.parse

from aiohttp import web

from .config import (
    STATE, PAIRING_CODE, save_persistent_state, request_save, ACTIVE_SLOT_STATES,
)
from .routes_common import *
from .routes_common import (
    OPEN_MODE, _PAIRING_WORDS, _pair_attempts, _device_persisted_at, _ACTIVE_DOWNLOADS,
    _json_body, _device_header, _device_header_text, _safe_display_text,
    _is_local_host_request, _require_host_dashboard, _authenticated_device,
    _device_permissions, _connection_kind, _host_addresses, _host_interfaces,
    _paired_device, _effective_device,
)
from .routes_transfers import _public_transfers, _cancel_device_transfer_jobs


async def pairing_qr_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    interfaces = _host_interfaces()
    if not interfaces:
        raise web.HTTPServiceUnavailable(text="No local IPv4 address is available for QR pairing")
    address = interfaces[0]["address"]
    port = request.url.port or 80
    from .routes_system import _is_port_80_proxy_active
    has_proxy = _is_port_80_proxy_active() if port != 80 else True
    port_part = "" if (port in (80, 443) or has_proxy) else f":{port}"
    pairing_url = f"{request.scheme}://{address}{port_part}/?pair_code={urllib.parse.quote(PAIRING_CODE)}"
    try:
        import qrcode
        from qrcode.image.svg import SvgPathImage
    except ImportError as exc:
        raise web.HTTPServiceUnavailable(text="QR generation is unavailable. Install project requirements and restart SuperShare.") from exc
    code = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_H, box_size=10, border=4)
    code.add_data(pairing_url)
    svg = code.make_image(image_factory=SvgPathImage).to_string(encoding="unicode")
    return web.Response(text=svg, content_type="image/svg+xml", headers={
        "Cache-Control": "no-store", "X-SuperShare-Pairing-URL": pairing_url,
    })

async def status_handler(request: web.Request) -> web.Response:
    device_id = _device_header(request, "id").strip()
    local_request = _is_local_host_request(request)
    with STATE["lock"]:
        existing = STATE["devices"].get(device_id, {})
        may_update_identity = local_request or not existing.get("token_hash") or _authenticated_device(request, existing)
    if device_id and may_update_identity:
        _touch_device(device_id, _device_header_text(request, "name", "Unknown device"),
                      _device_header_text(request, "platform", "Device"), request.remote,
                      create=local_request or OPEN_MODE)
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
    effective = _effective_device(request)
    perms = _device_permissions(request, effective)
    can_view = local_request or perms["read"]
    mine = []
    if not local_request and device_id:
        mine = [{**item, "destination": item.get("relative_path") or ""}
                for item in _public_transfers(device_id=device_id)]
    return web.json_response({
        "status": "online",
        "server": "SuperShare",
        "share_root": STATE["share_dir"] if can_view else None,
        "host_name": os.environ.get("COMPUTERNAME") or (os.uname().nodename if hasattr(os, "uname") else "SuperShare host"),
        "host_dashboard": local_request,
        "access": (effective or {}).get("access", "read-write"),
        "devices": _public_devices() if local_request else [],
        "transfers": _public_transfers() if local_request else [],
        "my_transfers": mine,
    })

async def upload_permission_handler(request: web.Request) -> web.Response:
    device_id = _device_header(request, "id").strip()
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
        _touch_device(device_id, _device_header_text(request, "name", "Unknown device"),
                      _device_header_text(request, "platform", "Device"), request.remote, create=local_request)
    local = _is_local_host_request(request)
    device = _paired_device(request)
    perms = {"read": True, "write": True} if (local or OPEN_MODE) else _device_permissions(request, device)
    confirmed = local or OPEN_MODE or bool(device and device.get("pair_confirmed"))
    return web.json_response({
        "allowed": perms["write"],
        "approved": any(perms.values()),
        "paired": local or OPEN_MODE or bool(device),
        "pair_confirmed": confirmed,
        "verification_phrase": None if confirmed or not device else device.get("verification_phrase"),
        "permissions": perms,
        "device_id": device_id,
        "message": "Connected & Ready to Share" if any(perms.values()) else "Waiting for host approval"
    })

async def pair_device_handler(request: web.Request) -> web.Response:
    body = await _json_body(request)
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
    response.set_cookie("supershare_token", token, httponly=True, secure=request.scheme == "https",
                        samesite="Strict", path="/api", max_age=31536000)
    return response

async def confirm_pairing_handler(request: web.Request) -> web.Response:
    device_id = _device_header(request, "id").strip()
    with STATE["lock"]:
        device = STATE["devices"].get(device_id, {})
        if not _authenticated_device(request, device):
            raise web.HTTPForbidden(text="This device is not paired")
        device["pair_confirmed"] = True
    save_persistent_state()
    return web.json_response({"status": "confirmed"})

def _touch_device(device_id, name, device_type, remote, create=True):
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", device_id):
        return
    if name in ("", "Unknown device") and device_type in ("", "Device"):
        return
    name = _safe_display_text(name, 80, "Unknown device")
    device_type = _safe_display_text(device_type, 40, "Device")
    remote = _safe_display_text(remote, 80, "") if remote else ""
    now = int(time.time())
    persist = False
    with STATE["lock"]:
        old = STATE["devices"].get(device_id)
        if old is None and not create:
            return
        old = old or {}
        saved_display_name = old.get("display_name", "")
        if isinstance(saved_display_name, str) and "\uFFFD" in saved_display_name and "\uFFFD" not in name:
            saved_display_name = ""
        display_name = _safe_display_text(saved_display_name or name, 80, "Unknown device")
        persist = (not old or old.get("name") != display_name
                   or old.get("type") != device_type
                   or old.get("ip") != (remote or old.get("ip", ""))
                   or not old.get("trusted")
                   or time.monotonic() - _device_persisted_at.get(device_id, 0) >= 60)
        STATE["devices"][device_id] = {
            "id": device_id,
            "name": display_name,
            "display_name": _safe_display_text(old.get("display_name", ""), 80, ""),
            "type": device_type,
            "ip": remote or old.get("ip", ""),
            "first_seen": old.get("first_seen", int(time.time())),
            "last_seen": now,
            "online": True,
            "trusted": True if OPEN_MODE else old.get("trusted", False),
            "approved_until": 0,
            "token_hash": old.get("token_hash", ""),
            "permissions": {"read": True, "write": True} if OPEN_MODE else old.get("permissions", {"read": False, "write": False}),
            "pair_confirmed": True if OPEN_MODE else old.get("pair_confirmed", False),
            "verification_phrase": old.get("verification_phrase", ""),
            **{key: old[key] for key in ("access", "paused", "limit_kbps") if key in old},
        }
    if persist:
        save_persistent_state()
        _device_persisted_at[device_id] = time.monotonic()
    _merge_duplicate_profiles(device_id)

def _merge_duplicate_profiles(new_id):
    now = int(time.time())
    with STATE["lock"]:
        new = STATE["devices"].get(new_id)
        if not new:
            return False
        merged = False
        for old_id, old in list(STATE["devices"].items()):
            if old_id == new_id:
                continue
            same = (old.get("type") == new.get("type")
                    and old.get("ip") == new.get("ip")
                    and (old.get("display_name") or old.get("name")) in (new.get("display_name") or new.get("name"), old.get("name"))
                    and now - old.get("last_seen", 0) > 25)
            if not same:
                continue
            for key in ("display_name", "access", "limit_kbps", "paused"):
                if key in old and key not in new or (key == "display_name" and old.get("display_name") and not new.get("display_name")):
                    new[key] = old[key]
            if old.get("display_name"):
                new["name"] = old["display_name"]
            new["first_seen"] = min(new.get("first_seen", now), old.get("first_seen", now))
            for job in STATE.get("transfer_jobs", {}).values():
                if job.get("device_id") == old_id:
                    job["device_id"] = new_id
            STATE["devices"].pop(old_id, None)
            merged = True
    if merged:
        save_persistent_state()
    return merged

def _public_devices():
    now = int(time.time())
    interfaces = _host_interfaces()
    with STATE["lock"]:
        active = {}
        for job in STATE.get("transfer_jobs", {}).values():
            if job.get("status") in ACTIVE_SLOT_STATES:
                active[job.get("device_id")] = active.get(job.get("device_id"), 0) + 1
        for dl in _ACTIVE_DOWNLOADS.values():
            active[dl["device_id"]] = active.get(dl["device_id"], 0) + 1
        result = []
        for device in STATE["devices"].values():
            item = dict(device)
            access = item.get("access", "read-write")
            item["access"] = access
            item["paused"] = bool(item.get("paused"))
            item["limit_kbps"] = int(item.get("limit_kbps") or 0)
            item["paired"] = True if OPEN_MODE else bool(item.get("token_hash"))
            item["pair_confirmed"] = True if OPEN_MODE else bool(item.get("pair_confirmed", False))
            item["trusted"] = True if OPEN_MODE else bool(item.get("trusted", False))
            if OPEN_MODE:
                item["permissions"] = {"read": access != "blocked", "write": access == "read-write"}
            item.pop("token_hash", None)
            item["online"] = now - item.get("last_seen", 0) < 25
            item["connection"] = _connection_kind(item.get("ip", ""), interfaces)
            item["active_transfers"] = active.get(item.get("id"), 0)
            result.append(item)
        return sorted(result, key=lambda d: (not d["online"], d["name"].lower()))

async def devices_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    return web.json_response({"devices": _public_devices(), "transfers": _public_transfers()})

async def rename_device_handler(request: web.Request) -> web.Response:
    body = await _json_body(request)
    device_id = body.get("id", "")
    name = _safe_display_text(body.get("name", ""), 80, "")
    local_request = _is_local_host_request(request)
    requester_id = _device_header(request, "id").strip()
    with STATE["lock"]:
        device = STATE["devices"].get(device_id)
        if not device or not name:
            raise web.HTTPBadRequest(text="Device and non-empty name are required")
        if not local_request and (requester_id != device_id or not _authenticated_device(request, device)):
            raise web.HTTPForbidden(text="Only the laptop dashboard or the authenticated browser profile can rename this profile")
        device["name"] = name
        device["display_name"] = name
    save_persistent_state()
    return web.json_response({"status": "ok"})

async def forget_device_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    body = await _json_body(request)
    with STATE["lock"]:
        STATE["devices"].pop(body.get("id", ""), None)
    _cancel_device_transfer_jobs(body.get("id", ""), "Browser profile was forgotten")
    save_persistent_state()
    return web.json_response({"status": "ok"})

async def revoke_device_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    body = await _json_body(request)
    with STATE["lock"]:
        device = STATE["devices"].get(body.get("id", ""))
        if not device:
            raise web.HTTPNotFound(text="Device not found")
        device["trusted"] = False
        device["approved_until"] = 0
        device["permissions"] = {"read": False, "write": False}
        device["token_hash"] = ""
        device["pair_confirmed"] = False
        device["verification_phrase"] = ""
    _cancel_device_transfer_jobs(body.get("id", ""), "Browser access was revoked")
    save_persistent_state()
    return web.json_response({"status": "ok"})

async def approve_device_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    body = await _json_body(request)
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

async def device_policy_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    body = await _json_body(request)
    device_id = str(body.get("id", ""))
    with STATE["lock"]:
        device = STATE["devices"].get(device_id)
        if not device:
            raise web.HTTPNotFound(text="Device not found")
        if "access" in body:
            if body["access"] not in {"read-only", "read-write", "blocked"}:
                raise web.HTTPBadRequest(text="access must be read-only, read-write, or blocked")
            device["access"] = body["access"]
        if "paused" in body:
            device["paused"] = bool(body["paused"])
        if "limit_kbps" in body:
            try:
                limit = int(body["limit_kbps"] or 0)
            except (TypeError, ValueError):
                raise web.HTTPBadRequest(text="limit_kbps must be a number")
            device["limit_kbps"] = 0 if limit <= 0 else max(256, min(limit, 10_000_000))
    if body.get("access") == "blocked":
        _cancel_device_transfer_jobs(device_id, "Blocked by the host")
    save_persistent_state()
    return web.json_response({"status": "ok"})

async def device_terminate_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    body = await _json_body(request)
    device_id = str(body.get("id", ""))
    with STATE["lock"]:
        count = sum(1 for job in STATE.get("transfer_jobs", {}).values()
                    if job.get("device_id") == device_id and job.get("status") in ACTIVE_SLOT_STATES | {"interrupted"})
    for dl in list(_ACTIVE_DOWNLOADS.values()):
        if dl["device_id"] == device_id:
            dl["stop"] = True
            count += 1
    _cancel_device_transfer_jobs(device_id, "Stopped by the host")
    return web.json_response({"status": "ok", "stopped": count})
