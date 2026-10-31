import queue
import zipfile
"""
api_routes.py — aiohttp REST and streaming endpoints for SuperShare.
"""
import os
import json
import errno
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

from .config import STATE, CHUNK_SIZE, MAX_CONCURRENT_TRANSFERS, PAIRING_CODE, save_persistent_state, request_save, record_transfer, ACTIVE_SLOT_STATES, STALE_TRANSFER_SECONDS
OPEN_MODE = os.environ.get("SUPERSHARE_OPEN_MODE") == "1"


def _paired_device(request):
    token = request.cookies.get("supershare_token", "")
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[7:]
    if not token:
        return None
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
    with STATE["lock"]:
        for d in STATE.get("devices", {}).values():
            if d.get("token_hash") and hmac.compare_digest(d["token_hash"], digest):
                return d
    return None


def _device_permissions(device):
    none = {"read": False, "write": False}
    if not device or not device.get("pair_confirmed"):
        return none
    if not device.get("trusted") and int(device.get("approved_until", 0)) < time.time():
        return none
    p = device.get("permissions", {})
    return {"read": bool(p.get("read")), "write": bool(p.get("write"))}


def _expire_stale_jobs(now=None):
    now_ts = int(now or time.time())
    changed = False
    for job in STATE.get("transfer_jobs", {}).values():
        if job.get("status") in {"queued", "transferring"} and now_ts - job.get("updated_at", 0) > STALE_TRANSFER_SECONDS:
            job["status"] = "interrupted"
            job["error"] = "Connection lost. Select the same file again to resume."
            job["updated_at"] = now_ts
            changed = True
    return changed


def _contiguous_chunks(mask: int) -> int:
    return ((~mask) & (mask + 1)).bit_length() - 1


def _write_chunk(path, offset, data):
    with open(path, "r+b") as out:
        out.seek(offset)
        out.write(data)
        out.flush()


def _hash_file(path, size):
    if os.path.getsize(path) != size:
        raise ValueError("Partial file size does not match the declared size")
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while block := f.read(4 * 1024 * 1024):
            h.update(block)
    return h.hexdigest()


def _publish(job):
    part = job["part_path"]
    dest = job["destination"]
    if job.get("collision") == "replace":
        os.replace(part, dest)
        return
    try:
        os.link(part, dest)
        os.remove(part)
    except FileExistsError:
        raise
    except OSError:
        if os.path.exists(dest):
            raise FileExistsError(dest)
        os.rename(part, dest)


def _fail(job, message):
    with STATE["lock"]:
        job["status"] = "failed"
        job["error"] = message
        job["updated_at"] = int(time.time())
        try:
            if os.path.exists(job.get("part_path", "")):
                os.remove(job["part_path"])
        except OSError:
            pass
    request_save()


def _content_disposition(name):
    ascii_name = name.encode("ascii", "replace").decode().replace('"', "_").replace("?", "_")
    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{urllib.parse.quote(name, safe="")}'


class _PipeWriter:
    def __init__(self, q, stop):
        self.q = q
        self.stop = stop
        self.pos = 0

    def write(self, b):
        while not self.stop.is_set():
            try:
                self.q.put(bytes(b), timeout=1)
                self.pos += len(b)
                return len(b)
            except queue.Full:
                continue
        raise BrokenPipeError("client went away")

    def tell(self):
        return self.pos

    def flush(self):
        pass


def iter_zip_entries(base, rel_paths):
    for rel in rel_paths:
        target = safe_join(base, rel)
        if os.path.isfile(target):
            yield target, os.path.basename(target)
        elif os.path.isdir(target):
            top = os.path.basename(target) or "shared"
            for root, _, files in os.walk(target):
                for f in files:
                    if not f.startswith(".supershare-") and not f.startswith(".temp_"):
                        full = os.path.join(root, f)
                        yield full, os.path.join(top, os.path.relpath(full, target))


async def _stream_zip(request, rel_paths, zip_name):
    entries = list(iter_zip_entries(STATE["share_dir"], rel_paths))
    q = queue.Queue(maxsize=16)
    stop = threading.Event() if "threading" in globals() else asyncio.Event()
    import threading
    stop_ev = threading.Event()
    skipped = []

    def produce():
        try:
            with zipfile.ZipFile(_PipeWriter(q, stop_ev), "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
                for path, arc in entries:
                    try:
                        zf.write(path, arc)
                    except OSError as exc:
                        skipped.append(f"{arc}: {exc.strerror}")
                if skipped:
                    zf.writestr("_SKIPPED_FILES.txt", "These files could not be read:\n" + "\n".join(skipped))
            q.put(None, timeout=5)
        except Exception as exc:
            try:
                q.put(exc, timeout=1)
            except Exception:
                pass

    resp = web.StreamResponse(headers={
        "Content-Type": "application/zip",
        "Content-Disposition": _content_disposition(zip_name),
        "Cache-Control": "no-store",
    })
    await resp.prepare(request)
    worker = asyncio.create_task(asyncio.to_thread(produce))
    try:
        while (item := await asyncio.to_thread(q.get)) is not None:
            if isinstance(item, Exception):
                raise item
            await resp.write(item)
        await resp.write_eof()
    finally:
        stop_ev.set()
        await asyncio.gather(worker, return_exceptions=True)
    return resp

from .file_manager import (
    safe_join,
    list_directory,
    list_host_folders,
    build_folder_zip,
    build_multi_selection_zip,
    delete_selected_items,
    sanitize_relative_path,
    JUNK_NAMES,
)

_pair_attempts = {}
_device_persisted_at = {}
_PAIRING_WORDS = ("amber", "birch", "cobalt", "delta", "ember", "fern", "granite", "harbor",
                  "indigo", "juniper", "kepler", "linen", "maple", "north", "onyx", "pepper",
                  "quartz", "river", "silver", "timber", "umber", "violet", "willow", "xenon",
                  "yellow", "zephyr")


def _safe_display_text(value, limit, fallback):
    text = str(value or fallback)
    text = "".join("\uFFFD" if 0xD800 <= ord(char) <= 0xDFFF else char for char in text)
    text = "".join(char for char in text if char in "\t " or ord(char) >= 0x20)
    return text.strip()[:limit] or fallback


def _device_header_text(request, header, fallback):
    # Custom HTTP headers are not a portable place for raw Unicode. The browser
    # percent-encodes profile labels; decode both new clients and legacy ASCII.
    return urllib.parse.unquote(request.headers.get(header, fallback), encoding="utf-8", errors="replace")


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


def _all_host_interfaces():
    interfaces = []
    try:
        import psutil
        for name, entries in psutil.net_if_addrs().items():
            for entry in entries:
                if entry.family != socket.AF_INET or not entry.address or entry.address.startswith("127."):
                    continue
                try:
                    iface = ipaddress.IPv4Interface(f"{entry.address}/{entry.netmask or '255.255.255.0'}")
                except ValueError:
                    continue
                interfaces.append({"name": name, "address": entry.address,
                                   "netmask": entry.netmask or "255.255.255.0",
                                   "broadcast": entry.broadcast or str(iface.network.broadcast_address)})
    except Exception:
        pass
    unique = {(item["name"], item["address"]): item for item in interfaces}
    interfaces = list(unique.values())
    if interfaces:
        return interfaces
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
    return [{"name": "Detected network", "address": address, "netmask": "", "broadcast": ""}
            for address in sorted(addresses)]


def _select_hotspot_interface(interfaces):
    candidates = []
    excluded_names = ("tailscale", "vpn", "vmware", "virtualbox", "hyper-v", "vethernet", "bluetooth", "docker", "wsl")
    for item in interfaces:
        try:
            address = ipaddress.ip_address(item["address"])
        except (ValueError, KeyError, TypeError):
            continue
        if address.version != 4 or address.is_loopback or address.is_link_local or address.is_multicast:
            continue
        name = str(item.get("name", "")).lower()
        if any(marker in name for marker in excluded_names):
            continue
        hosted_hotspot = str(address) == "192.168.137.1" or ("local area connection*" in name and address.is_private)
        wireless = any(marker in name for marker in ("wi-fi", "wifi", "wireless", "wlan"))
        if not hosted_hotspot and not wireless:
            continue
        kind = "Windows hotspot" if hosted_hotspot else "Wi-Fi / hotspot"
        # Prefer Windows Mobile Hotspot when it is present: this setup has the
        # phone and other clients join this laptop. Wi-Fi remains the fallback
        # for when the laptop joins a phone-provided hotspot or shared Wi-Fi.
        rank = 0 if hosted_hotspot else 1 if wireless else 2
        candidates.append((rank, {**item, "kind": kind}))
    if not candidates:
        return []
    candidates.sort(key=lambda entry: (entry[0], entry[1].get("name", "").lower(), entry[1]["address"]))
    return [candidates[0][1]]


def _host_interfaces():
    return _select_hotspot_interface(_all_host_interfaces())


def _host_addresses():
    return [item["address"] for item in _host_interfaces()]


async def network_handler(request: web.Request) -> web.Response:
    interfaces = _host_interfaces()
    connection = None
    if interfaces:
        selected = interfaces[0]
        port = request.url.port or 80
        scheme = request.scheme
        connection = {"name": selected["name"], "kind": selected.get("kind", "Local network"),
                      "address": selected["address"], "url": f"{scheme}://{selected['address']}/" if port in (80, 443) else f"{scheme}://{selected['address']}:{port}/"}
    return web.json_response({
        "service": "SuperShare",
        "protocol_version": 1,
        "port": request.url.port or 80,
        "scheme": request.scheme,
        "ca_fingerprint": request.app.get("tls_info", {}).get("ca_fingerprint"),
        "addresses": [connection["address"]] if connection else [],
        "interfaces": interfaces,
        "connection": connection,
        "connection_path": "/",
        "pairing_required": True,
        "internet_required": False,
    })


async def pairing_qr_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    interfaces = _host_interfaces()
    if not interfaces:
        raise web.HTTPServiceUnavailable(text="No local IPv4 address is available for QR pairing")
    address = interfaces[0]["address"]
    port = request.url.port or 80
    port_part = "" if port in (80, 443) else f":{port}"
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


async def diagnostics_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    root = STATE["share_dir"]
    try:
        usage = shutil.disk_usage(root)
        with STATE["lock"]:
            active_jobs = [job for job in STATE.get("transfer_jobs", {}).values()
                           if job.get("status") in {"queued", "transferring", "interrupted", "verifying"}]
            reserved_bytes = sum(max(0, job.get("size", 0) - job.get("offset", 0)) for job in active_jobs)
        storage = {"available_bytes": usage.free, "reserved_bytes": reserved_bytes,
                   "active_transfer_count": len(active_jobs), "total_bytes": usage.total}
    except OSError as exc:
        storage = {"error": str(exc)}
    return web.json_response({"service": "online", "protocol_version": 1, "port": request.url.port or 80,
                              "addresses": _host_addresses(), "interfaces": _host_interfaces(), "receive_root": root, "storage": storage,
                              "pairing_code_rotates_on_restart": True})


async def status_handler(request: web.Request) -> web.Response:
    device_id = request.headers.get("X-SuperShare-Device", "").strip()
    local_request = _is_local_host_request(request)
    with STATE["lock"]:
        existing = STATE["devices"].get(device_id, {})
        may_update_identity = local_request or not existing.get("token_hash") or _authenticated_device(request, existing)
    if device_id and may_update_identity:
        _touch_device(device_id, _device_header_text(request, "X-SuperShare-Name", "Unknown device"),
                      _device_header_text(request, "X-SuperShare-Type", "Device"), request.remote)
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
    can_view = local_request or OPEN_MODE or _device_permissions(_paired_device(request))["read"]
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
        _touch_device(device_id, _device_header_text(request, "X-SuperShare-Name", "Unknown device"),
                      _device_header_text(request, "X-SuperShare-Type", "Device"), request.remote)
    local = _is_local_host_request(request)
    device = _paired_device(request)
    perms = {"read": True, "write": True} if (local or OPEN_MODE) else _device_permissions(device)
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
    with STATE["lock"]:
        existing = STATE.get("devices", {}).get(device_id)
        if existing and existing.get("token_hash") and not _is_local_host_request(request):
            raise web.HTTPForbidden(text="This device is already paired and cannot be overwritten")
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
    name = _safe_display_text(name, 80, "Unknown device")
    device_type = _safe_display_text(device_type, 40, "Device")
    remote = _safe_display_text(remote, 80, "") if remote else ""
    now = int(time.time())
    persist = False
    with STATE["lock"]:
        old = STATE["devices"].get(device_id, {})
        saved_display_name = old.get("display_name", "")
        if isinstance(saved_display_name, str) and "\uFFFD" in saved_display_name and "\uFFFD" not in name:
            saved_display_name = ""
        display_name = _safe_display_text(saved_display_name or name, 80, "Unknown device")
        persist = (not old or old.get("name") != display_name
                   or old.get("type") != device_type
                   or old.get("ip") != (remote or old.get("ip", ""))
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
        if not ipaddress.ip_address(request.remote or "").is_loopback:
            return False
        request_host = urllib.parse.urlsplit(f"//{request.host}").hostname
        if request_host not in {"localhost", "127.0.0.1", "::1"}:
            return False
        fetch_site = request.headers.get("Sec-Fetch-Site", "").lower()
        if fetch_site and fetch_site not in {"same-origin", "none"}:
            return False
        origin = request.headers.get("Origin")
        if origin:
            parsed_origin = urllib.parse.urlsplit(origin)
            if parsed_origin.scheme != request.scheme or parsed_origin.netloc.lower() != request.host.lower():
                return False
        elif request.headers.get("Referer") and fetch_site != "same-origin":
            referer = urllib.parse.urlsplit(request.headers["Referer"])
            if referer.scheme != request.scheme or referer.netloc.lower() != request.host.lower():
                return False
        return True
    except (ValueError, TypeError):
        return False


def _require_host_dashboard(request):
    if not _is_local_host_request(request):
        raise web.HTTPForbidden(text="This host control is available from the laptop dashboard only")


def _require_share_access(request, permission="read"):
    if OPEN_MODE or _is_local_host_request(request):
        return
    perms = _device_permissions(_paired_device(request))
    if not perms.get(permission):
        raise web.HTTPForbidden(text=f"The host has not granted this browser {permission} access")


def _authorize_transfer_write(request):
    _require_share_access(request, "write")
    device = _paired_device(request)
    return device["id"] if device else (request.headers.get("X-SuperShare-Device", "").strip() or "local-dashboard")


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
    body = await request.json()
    device_id = body.get("id", "")
    name = _safe_display_text(body.get("name", ""), 80, "")
    local_request = _is_local_host_request(request)
    requester_id = request.headers.get("X-SuperShare-Device", "").strip()
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
    body = await request.json()
    with STATE["lock"]:
        STATE["devices"].pop(body.get("id", ""), None)
    _cancel_device_transfer_jobs(body.get("id", ""), "Browser profile was forgotten")
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
        device["token_hash"] = ""
        device["pair_confirmed"] = False
        device["verification_phrase"] = ""
    _cancel_device_transfer_jobs(body.get("id", ""), "Browser access was revoked")
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
    # Hide internal temporary partial upload files from the UI
    items = [it for it in items if not str(it.get("name", "")).startswith(".supershare-")]
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
    await request.json()
    try:
        selected = await asyncio.to_thread(_open_tk_folder_picker, STATE["share_dir"])
        if selected and os.path.isdir(selected):
            updated_root = os.path.abspath(selected)
            if os.path.realpath(updated_root) != os.path.realpath(STATE["share_dir"]):
                _cancel_active_transfer_jobs("Receive root changed")
            STATE["share_dir"] = updated_root
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
    updated_root = os.path.abspath(new_dir)
    if os.path.realpath(updated_root) != os.path.realpath(STATE["share_dir"]):
        _cancel_active_transfer_jobs("Receive root changed")
    STATE["share_dir"] = updated_root
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
    res = await asyncio.to_thread(delete_selected_items, STATE["share_dir"], items)
    return web.json_response({"status": "ok", "deleted": res.get("deleted", 0), "failed": res.get("failed", [])})


async def download_handler(request: web.Request) -> web.Response:
    _require_share_access(request)
    target = safe_join(STATE["share_dir"], request.query.get("path", ""))
    if not os.path.isfile(target):
        raise web.HTTPNotFound(text="File not found")
    name = os.path.basename(target)
    rng = request.headers.get("Range", "")
    if not rng or rng.startswith("bytes=0-"):
        device_id = request.headers.get("X-SuperShare-Device", "local-dashboard")
        await asyncio.to_thread(record_transfer, device_id, name, os.path.getsize(target),
                                "completed", "Download started", device_id, "send")
    return web.FileResponse(target, headers={
        "Content-Disposition": _content_disposition(name),
        "Cache-Control": "no-store",
    })


async def _stream_and_remove_zip(request: web.Request, tmp_zip: str, zip_filename: str) -> web.StreamResponse:
    device_id = request.headers.get("X-SuperShare-Device", "local-dashboard")
    sent = 0
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
                sent += len(chunk)
        await resp.write_eof()
        record_transfer(device_id, zip_filename, zip_size, detail="Sent ZIP to connected device", destination=device_id, direction="send")
        return resp
    except Exception as exc:
        record_transfer(device_id, zip_filename, sent, status="failed", detail=f"ZIP download interrupted: {str(exc)[:140]}", destination=device_id, direction="send")
        raise
    finally:
        if os.path.exists(tmp_zip):
            try:
                os.remove(tmp_zip)
            except Exception:
                pass


async def zip_folder_handler(request: web.Request) -> web.StreamResponse:
    _require_share_access(request)
    rel = request.query.get("path", "")
    zip_name = (os.path.basename(rel.rstrip("/")) or "shared-folder") + ".zip"
    return await _stream_zip(request, [rel], zip_name)


async def zip_selected_handler(request: web.Request) -> web.StreamResponse:
    _require_share_access(request)
    items = json.loads(request.query.get("items", "[]"))
    return await _stream_zip(request, items, f"supershare_selected_{len(items)}.zip")





def _available_transfer_space(exclude_job_id=None, existing_allocation=0):
    free_bytes = shutil.disk_usage(STATE["share_dir"]).free
    with STATE["lock"]:
        reserved = sum(
            max(0, int(job.get("size", 0)) - int(job.get("offset", 0)))
            for job_id, job in STATE.get("transfer_jobs", {}).items()
            if job_id != exclude_job_id and job.get("status") in {"queued", "transferring", "interrupted", "verifying"}
        )
    return max(0, free_bytes + max(0, existing_allocation) - reserved)


def _cancel_active_transfer_jobs(reason):
    changed = False
    with STATE["lock"]:
        for job in STATE.get("transfer_jobs", {}).values():
            if job.get("status") not in {"queued", "transferring", "interrupted", "verifying"}:
                continue
            try:
                os.remove(job.get("part_path", ""))
            except OSError:
                pass
            job["status"] = "cancelled"
            job["error"] = reason
            job["updated_at"] = int(time.time())
            changed = True
        if changed:
            save_persistent_state()


def _cancel_device_transfer_jobs(device_id, reason):
    changed = False
    with STATE["lock"]:
        for job in STATE.get("transfer_jobs", {}).values():
            if job.get("device_id") != device_id or job.get("status") not in {"queued", "transferring", "interrupted", "verifying"}:
                continue
            try:
                os.remove(job.get("part_path", ""))
            except OSError:
                pass
            job["status"] = "cancelled"
            job["error"] = reason
            job["updated_at"] = int(time.time())
            changed = True
    if changed:
        save_persistent_state()


async def create_transfer_handler(request: web.Request) -> web.Response:
    device_id = _authorize_transfer_write(request)
    try:
        body = await request.json()
        name = str(body.get("name", "")).strip()
        size = int(body.get("size", -1))
        resume_id = str(body.get("resume_id", ""))
        collision = str(body.get("collision", "ask"))
    except (ValueError, TypeError):
        raise web.HTTPBadRequest(text="Invalid transfer details")
    if not name or size < 0 or size > 100 * 1024**3:
        raise web.HTTPBadRequest(text="A filename and size up to 100 GB are required")

    try:
        destination = sanitize_relative_path(str(body.get("path", name)))
    except (PermissionError, ValueError) as exc:
        raise web.HTTPBadRequest(text=str(exc))
    if os.path.basename(destination).lower() in JUNK_NAMES:
        return web.json_response({"status": "skipped", "filename": os.path.basename(destination)})

    target = safe_join(STATE["share_dir"], destination)
    if len(target) > 240:
        raise web.HTTPBadRequest(text="Path is too long for Windows (240 characters max)")

    os.makedirs(os.path.dirname(target), exist_ok=True)

    if resume_id:
        with STATE["lock"]:
            _expire_stale_jobs()
            existing_job = STATE.get("transfer_jobs", {}).get(resume_id)
            if (existing_job and existing_job.get("device_id") == device_id and existing_job.get("size") == size
                    and existing_job.get("destination") == target and existing_job.get("status") == "completed"):
                return web.json_response({"id": resume_id, "filename": existing_job["filename"], "offset": size,
                                          "chunk_size": CHUNK_SIZE, "status": "completed"})
            if (existing_job and existing_job.get("device_id") == device_id and existing_job.get("size") == size
                    and existing_job.get("destination") == target and existing_job.get("status") in {"queued", "transferring", "interrupted"}):
                partial_path = existing_job["part_path"]
                if not os.path.exists(partial_path):
                    existing_job["mask"], existing_job["offset"] = "0", 0
                    open(partial_path, "xb").close()
                existing_job["share_root"] = os.path.realpath(STATE["share_dir"])
                try:
                    available = _available_transfer_space(exclude_job_id=resume_id, existing_allocation=existing_job["offset"])
                    if size > available:
                        raise web.HTTPInsufficientStorage(text="Not enough unreserved space to resume this transfer")
                except OSError:
                    raise web.HTTPInsufficientStorage(text="The selected receive drive is unavailable")
                existing_job["status"] = "interrupted"
                existing_job["updated_at"] = int(time.time())
                request_save()
                return web.json_response({"id": resume_id, "filename": existing_job["filename"], "offset": existing_job["offset"],
                                          "chunk_size": CHUNK_SIZE, "status": "interrupted"})
            if (existing_job and existing_job.get("device_id") == device_id and existing_job.get("size") == size
                    and existing_job.get("destination") == target and existing_job.get("status") == "failed"
                    and not os.path.exists(target)):
                active = [j for j in STATE.get("transfer_jobs", {}).values() if j.get("status") in ACTIVE_SLOT_STATES]
                if len(active) >= MAX_CONCURRENT_TRANSFERS or sum(j.get("device_id") == device_id for j in active) >= MAX_CONCURRENT_TRANSFERS:
                    raise web.HTTPTooManyRequests(text=f"Transfer limit reached ({MAX_CONCURRENT_TRANSFERS} active jobs).")
                partial_path = existing_job["part_path"]
                if not os.path.exists(partial_path):
                    open(partial_path, "xb").close()
                else:
                    with open(partial_path, "r+b") as partial:
                        partial.truncate(0)
                existing_job["offset"] = 0
                existing_job["mask"] = "0"
                existing_job["share_root"] = os.path.realpath(STATE["share_dir"])
                try:
                    available = _available_transfer_space(exclude_job_id=resume_id)
                    if size > available:
                        raise web.HTTPInsufficientStorage(text="Not enough unreserved space to restart this transfer")
                except OSError:
                    raise web.HTTPInsufficientStorage(text="The selected receive drive is unavailable")
                existing_job["status"] = "queued"
                existing_job["updated_at"] = int(time.time())
                existing_job.pop("error", None)
                request_save()
                return web.json_response({"id": resume_id, "filename": existing_job["filename"], "offset": 0,
                                          "chunk_size": CHUNK_SIZE, "status": "queued"})

    if collision not in {"ask", "skip", "rename", "replace"}:
        raise web.HTTPBadRequest(text="Collision choice must be ask, skip, rename, or replace")

    with STATE["lock"]:
        # Check if target is already reserved by another active job (L12)
        reserved_targets = {
            j.get("destination") for j in STATE.get("transfer_jobs", {}).values()
            if j.get("status") in ACTIVE_SLOT_STATES
        }
        if os.path.exists(target) or target in reserved_targets:
            if collision == "ask":
                return web.json_response({"error": "destination_exists", "filename": os.path.basename(target), "choices": ["skip", "rename", "replace", "cancel"]}, status=409)
            if collision == "skip":
                return web.json_response({"status": "skipped", "filename": os.path.basename(target)})
            if collision == "rename":
                stem, extension = os.path.splitext(target)
                suffix = 1
                while os.path.exists(f"{stem} ({suffix}){extension}") or f"{stem} ({suffix}){extension}" in reserved_targets:
                    suffix += 1
                target = f"{stem} ({suffix}){extension}"

    job_id = uuid.uuid4().hex
    part_path = os.path.join(os.path.dirname(target), f".supershare-{job_id}.partial")
    job = {
        "id": job_id, "device_id": device_id, "filename": os.path.basename(target),
        "destination": target, "part_path": part_path, "size": size, "offset": 0, "mask": "0",
        "share_root": os.path.realpath(STATE["share_dir"]), "collision": collision,
        "status": "queued", "created_at": int(time.time()), "updated_at": int(time.time())
    }

    with STATE["lock"]:
        _expire_stale_jobs()
        active = [j for j in STATE.get("transfer_jobs", {}).values() if j.get("status") in ACTIVE_SLOT_STATES]
        if len(active) >= MAX_CONCURRENT_TRANSFERS or sum(j.get("device_id") == device_id for j in active) >= MAX_CONCURRENT_TRANSFERS:
            raise web.HTTPTooManyRequests(text=f"Transfer limit reached ({MAX_CONCURRENT_TRANSFERS} active jobs).")
        try:
            if size > _available_transfer_space():
                raise web.HTTPInsufficientStorage(text="Not enough unreserved space on the receive drive")
        except OSError:
            raise web.HTTPInsufficientStorage(text="The receive drive is unavailable")
        STATE.setdefault("transfer_jobs", {})[job_id] = job

    try:
        await asyncio.to_thread(lambda: open(part_path, "xb").close())
    except OSError as exc:
        with STATE["lock"]:
            STATE.get("transfer_jobs", {}).pop(job_id, None)
        raise web.HTTPInsufficientStorage(text=f"Cannot create the partial file: {exc.strerror}")

    request_save()
    return web.json_response({
        "id": job_id, "filename": job["filename"], "offset": 0,
        "chunk_size": CHUNK_SIZE, "status": "queued"
    }, status=201)


def _get_transfer_job(request, job_id):
    device_id = _authorize_transfer_write(request)
    with STATE["lock"]:
        job = STATE.get("transfer_jobs", {}).get(job_id)
        if not job or (not _is_local_host_request(request) and not OPEN_MODE and job.get("device_id") != device_id):
            raise web.HTTPNotFound(text="Transfer session not found")
        return job


async def transfer_chunk_handler(request: web.Request) -> web.Response:
    job = _get_transfer_job(request, request.match_info["job_id"])
    try:
        offset = int(request.headers["X-Chunk-Offset"])
    except (KeyError, ValueError):
        raise web.HTTPBadRequest(text="Missing or invalid X-Chunk-Offset")
    size = job["size"]
    if offset < 0 or offset >= size or (offset % CHUNK_SIZE != 0):
        raise web.HTTPBadRequest(text="Chunk offset must be chunk-aligned and inside the file")
    expected = min(CHUNK_SIZE, size - offset)
    supplied = request.headers.get("X-Chunk-SHA256", "").lower()
    if not re.fullmatch(r"[a-f0-9]{64}", supplied):
        raise web.HTTPBadRequest(text="X-Chunk-SHA256 header is required")

    buf = bytearray()
    async for piece in request.content.iter_chunked(256 * 1024):
        buf.extend(piece)
        if len(buf) > expected:
            raise web.HTTPRequestEntityTooLarge(max_size=expected, actual_size=len(buf))
    if len(buf) != expected:
        raise web.HTTPBadRequest(text=f"Chunk must contain exactly {expected} bytes at this offset")

    actual = await asyncio.to_thread(lambda: hashlib.sha256(buf).hexdigest())
    if not hmac.compare_digest(actual, supplied):
        raise web.HTTPUnprocessableEntity(text="Chunk SHA-256 mismatch; resend this chunk")

    with STATE["lock"]:
        if job["status"] not in {"queued", "transferring", "interrupted"}:
            raise web.HTTPConflict(text=f"Transfer is {job['status']}")
        job["status"], job["updated_at"] = "transferring", int(time.time())

    try:
        await asyncio.to_thread(_write_chunk, job["part_path"], offset, buf)
    except FileNotFoundError:
        raise web.HTTPConflict(text="The partial file is missing on the host; restart this transfer")
    except OSError as exc:
        full = getattr(exc, "errno", None) == errno.ENOSPC
        with STATE["lock"]:
            job["status"] = "interrupted"
            job["error"] = "Receive drive is full" if full else f"Host write failed: {str(exc)[:120]}"
            job["updated_at"] = int(time.time())
        request_save()
        if full:
            raise web.HTTPInsufficientStorage(text=job["error"]) from exc
        raise web.HTTPInternalServerError(text=job["error"]) from exc

    with STATE["lock"]:
        mask = int(job.get("mask", "0"), 16) | (1 << (offset // CHUNK_SIZE))
        job["mask"] = format(mask, "x")
        job["offset"] = min(size, _contiguous_chunks(mask) * CHUNK_SIZE)
        job["updated_at"] = int(time.time())

    return web.json_response({"offset": job["offset"], "status": job["status"]})


async def transfer_status_handler(request: web.Request) -> web.Response:
    job = _get_transfer_job(request, request.match_info["job_id"])
    return web.json_response({key: job[key] for key in ("id", "filename", "destination", "size", "offset", "status", "updated_at", "error") if key in job})


async def complete_transfer_handler(request: web.Request) -> web.Response:
    job = _get_transfer_job(request, request.match_info["job_id"])
    size = job["size"]
    total = -(-size // CHUNK_SIZE) if size > 0 else 0
    with STATE["lock"]:
        if size > 0 and int(job.get("mask", "0"), 16) != (1 << total) - 1:
            raise web.HTTPConflict(text="Transfer is incomplete; resume from the acknowledged offset")
        if job["status"] not in {"queued", "transferring", "interrupted"}:
            raise web.HTTPConflict(text=f"Transfer is {job['status']}")
        job["status"], job["updated_at"] = "verifying", int(time.time())

    try:
        digest = await asyncio.to_thread(_hash_file, job["part_path"], job["size"])
        with STATE["lock"]:
            if job["status"] != "verifying":
                raise web.HTTPConflict(text=f"Transfer was {job['status']} before it could be published")
            if os.path.realpath(STATE["share_dir"]) != job.get("share_root"):
                raise web.HTTPConflict(text="Receive root changed; transfer was cancelled")
        await asyncio.to_thread(_publish, job)
    except web.HTTPException:
        raise
    except FileExistsError:
        _fail(job, "A file already exists at this destination")
        raise web.HTTPConflict(text=job["error"])
    except Exception as exc:
        _fail(job, f"Could not publish file: {exc}")
        raise web.HTTPInternalServerError(text=job["error"]) from exc

    with STATE["lock"]:
        job.update(status="completed", sha256=digest, updated_at=int(time.time()))
    request_save()
    await asyncio.to_thread(record_transfer, job["device_id"], job["filename"], job["size"],
                            "completed", f"SHA-256 {digest}", job["destination"])
    return web.json_response({"status": "completed", "sha256": digest})


async def cancel_transfer_handler(request: web.Request) -> web.Response:
    job = _get_transfer_job(request, request.match_info["job_id"])
    with STATE["lock"]:
        if job["status"] in {"completed", "cancelled"}:
            raise web.HTTPConflict(text=f"Transfer is {job['status']}")
        try:
            os.remove(job["part_path"])
        except OSError:
            pass
        actor = "host" if _is_local_host_request(request) else "sender"
        job["status"] = "cancelled"
        job["error"] = f"Cancelled by {actor}"
        job["updated_at"] = int(time.time())
        request_save()
    return web.json_response({"status": "cancelled"})


async def storage_info_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    share_dir = STATE["share_dir"]
    try:
        usage = shutil.disk_usage(share_dir)
        total_space = usage.total
        free_space = usage.free
        used_space = usage.used
    except OSError:
        total_space = free_space = used_space = 0

    shared_files_bytes = 0
    shared_files_count = 0
    partial_bytes = 0
    partial_count = 0

    try:
        for root, dirs, files in os.walk(share_dir):
            for f in files:
                fp = os.path.join(root, f)
                try:
                    sz = os.path.getsize(fp)
                    if f.startswith(".supershare-") and f.endswith(".partial"):
                        partial_count += 1
                        partial_bytes += sz
                    else:
                        shared_files_count += 1
                        shared_files_bytes += sz
                except OSError:
                    pass
    except OSError:
        pass

    with STATE["lock"]:
        devices_count = len(STATE["devices"])
        transfers_count = len(STATE["transfers"])

    return web.json_response({
        "share_dir": share_dir,
        "disk_total": total_space,
        "disk_free": free_space,
        "disk_used": used_space,
        "shared_files_bytes": shared_files_bytes,
        "shared_files_count": shared_files_count,
        "partial_bytes": partial_bytes,
        "partial_count": partial_count,
        "devices_count": devices_count,
        "transfers_count": transfers_count
    })


async def clear_history_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    from .config import clear_transfers_history
    clear_transfers_history()
    return web.json_response({"status": "ok", "message": "Transfer history cleared"})


async def clear_partials_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    from .config import clear_temp_partials
    res = clear_temp_partials()
    return web.json_response({"status": "ok", "removed": res["removed"], "reclaimed_bytes": res["reclaimed_bytes"]})


async def reset_state_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    from .config import reset_all_stored_state
    reset_all_stored_state()
    return web.json_response({"status": "ok", "message": "All devices and database history reset"})
