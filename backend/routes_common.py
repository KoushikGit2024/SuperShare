"""
routes_common.py — Shared constants, security helpers, and interface utilities.
"""
import asyncio
import errno
import hashlib
import hmac
import ipaddress
import json
import os
import queue
import re
import secrets
import shutil
import socket
import stat as _stat
import threading
import time
import urllib.parse
import uuid
import zipfile

import aiohttp
from aiohttp import web

from .config import (
    STATE, CHUNK_SIZE, MAX_CONCURRENT_TRANSFERS, MAX_TRANSFERS_PER_DEVICE, PAIRING_CODE, save_persistent_state,
    request_save, record_transfer, ACTIVE_SLOT_STATES, STALE_TRANSFER_SECONDS,
)

_ClientConnectionReset = getattr(aiohttp, "ClientConnectionResetError", ConnectionResetError)
DISCONNECT_ERRORS = (ConnectionResetError, ConnectionError, _ClientConnectionReset)

OPEN_MODE = os.environ.get("SUPERSHARE_OPEN_MODE", "1") != "0"
FSYNC_MODE = os.environ.get("SUPERSHARE_FSYNC", "chunk").lower()
STALE_PARTIAL_SECONDS = 7 * 24 * 60 * 60

# Runtime state maps
_throttle_next = {}
_CHUNK_HASHES = {}  # in-memory: job_id -> {chunk_index: sha256_hex}
_ACTIVE_DOWNLOADS = {}
_pair_attempts = {}
_device_persisted_at = {}

_HEADER_ALIASES = {
    "X-Device-Id": ("X-Device-Id", "X-SuperShare-Device-Id", "X-SuperShare-Id"),
    "X-Device-Name": ("X-Device-Name", "X-SuperShare-Device-Name", "X-SuperShare-Name"),
    "X-Device-Type": ("X-Device-Type", "X-SuperShare-Device-Type", "X-SuperShare-Type"),
    "X-Device-Token": ("X-Device-Token", "X-SuperShare-Device-Token", "X-SuperShare-Token"),
}

_EXCLUDED_ADAPTERS = ("vethernet", "virtualbox", "vmware", "hyper-v", "loopback", "wsl", "bluetooth")

_PAIRING_WORDS = (
    "amber", "anchor", "apple", "beacon", "breeze", "cedar", "canyon", "cherry",
    "clover", "copper", "coral", "dawn", "delta", "ember", "falcon", "forest",
    "frost", "harbor", "haven", "island", "meadow", "orbit", "peak", "pebble",
    "quarry", "river", "rover", "shadow", "sierra", "silver", "summit", "timber",
    "valley", "velvet", "whisper", "willow", "zephyr",
)


async def _json_body(request: web.Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        raise web.HTTPBadRequest(text="Invalid JSON payload")
    if not isinstance(body, dict):
        raise web.HTTPBadRequest(text="Expected a JSON object")
    return body


def _same_target(job, target):
    return (
        os.path.abspath(job.get("destination", "")) == os.path.abspath(target)
        or os.path.abspath(job.get("requested_destination", "")) == os.path.abspath(target)
    )


def _paired_device(request: web.Request):
    device_id = _device_header(request, "X-Device-Id")
    if not device_id:
        return None
    with STATE["lock"]:
        device = STATE["devices"].get(device_id)
        if not device or not device.get("pair_confirmed"):
            return None
        token = _device_header(request, "X-Device-Token")
        token_hash = device.get("token_hash", "")
        if not token or not token_hash or not hmac.compare_digest(
            hashlib.sha256(token.encode("utf-8")).hexdigest(), token_hash
        ):
            return None
        return dict(device)


def _device_permissions(request: web.Request, device=None):
    if _is_local_host_request(request):
        return {"read": True, "write": True, "control": True}
    if device is None:
        device = _paired_device(request)
    if not device:
        if OPEN_MODE:
            return {"read": True, "write": True, "control": False}
        return {"read": False, "write": False, "control": False}
    access = device.get("access", "allowed")
    if access == "blocked":
        return {"read": False, "write": False, "control": False}
    perms = dict(device.get("permissions") or {"read": True, "write": True})
    perms["control"] = False
    return perms


def _effective_device(request: web.Request):
    device = _paired_device(request)
    if device:
        return device
    remote = _request_ip(request)
    with STATE["lock"]:
        for d in STATE["devices"].values():
            if d.get("ip") == remote and d.get("pair_confirmed"):
                return dict(d)
    return None


def _connection_kind(ip, interfaces):
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return "Network"
    if address.is_loopback:
        return "This laptop"
    for item in interfaces:
        try:
            network = ipaddress.ip_network(f"{item['address']}/{item.get('netmask') or '255.255.255.0'}", strict=False)
        except ValueError:
            continue
        if address in network:
            return item.get("kind", "Local network")
    return "Network"


async def _throttle(device_id, nbytes, limit_kbps):
    if not limit_kbps:
        return
    limit_bps = limit_kbps * 1024
    now = time.monotonic()
    burst = _throttle_next.get(device_id, now)
    burst = max(burst, now) + (nbytes / limit_bps)
    _throttle_next[device_id] = burst
    delay = burst - time.monotonic()
    if delay > 0.005:
        await asyncio.sleep(min(delay, 2.0))


def _expire_stale_jobs():
    now = int(time.time())
    changed = False
    for job in STATE.get("transfer_jobs", {}).values():
        if job.get("status") in {"transferring", "queued"}:
            if now - job.get("updated_at", job.get("created_at", now)) > STALE_TRANSFER_SECONDS:
                job["status"] = "interrupted"
                job["error"] = "Transfer interrupted by network timeout"
                job["updated_at"] = now
                changed = True
    return changed


def _contiguous_chunks(mask_int):
    count = 0
    while mask_int & (1 << count):
        count += 1
    return count


def _safe_display_text(value, max_length=80, fallback=""):
    text = re.sub(r"[\x00-\x1f\x7f-\x9f]", "", str(value or "")).strip()
    return text[:max_length] if text else fallback


def _device_header(request: web.Request, key: str, fallback: str = "") -> str:
    aliases = _HEADER_ALIASES.get(key)
    if aliases:
        for header in aliases:
            value = request.headers.get(header)
            if value:
                return value.strip()
    direct = request.headers.get(key)
    if direct:
        return direct.strip()
    return fallback


def _device_header_text(request: web.Request, key: str, fallback: str = "") -> str:
    return urllib.parse.unquote(_device_header(request, key, fallback), encoding="utf-8", errors="replace")


def _relative_to_share(abs_path, share_dir):
    try:
        rel = os.path.relpath(abs_path, share_dir)
        return "" if rel == "." else rel.replace(os.sep, "/")
    except ValueError:
        return ""


def _all_host_interfaces():
    interfaces = []
    seen = set()
    try:
        import psutil
        net_addrs = psutil.net_if_addrs()
        for name, addrs in net_addrs.items():
            for addr in addrs:
                if getattr(addr, "family", None) != socket.AF_INET:
                    continue
                ip = addr.address
                if ip.startswith("127.") or ip in seen:
                    continue
                seen.add(ip)
                interfaces.append({"name": name, "address": ip})
    except ImportError:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("10.255.255.255", 1))
            sock_ip = s.getsockname()[0]
            if not sock_ip.startswith("127.") and sock_ip not in seen:
                seen.add(sock_ip)
                interfaces.append({"name": "Default Interface", "address": sock_ip})
        finally:
            s.close()
    except Exception:
        pass
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            host_ip = info[4][0]
            if not host_ip.startswith("127.") and host_ip not in seen:
                seen.add(host_ip)
                interfaces.append({"name": "Host Adapter", "address": host_ip})
    except Exception:
        pass
    return interfaces


def _select_hotspot_interface(interfaces):
    ranked = []
    for item in interfaces:
        try:
            address = ipaddress.ip_address(item["address"])
        except (ValueError, KeyError, TypeError):
            continue
        if address.version != 4 or address.is_loopback or address.is_link_local or address.is_multicast or not address.is_private:
            continue
        name = str(item.get("name", "")).lower()
        # Skip loopback/bridge adapters; be careful not to exclude "local area connection*"
        if name == "lo" or name.startswith("br-") or any(m in name for m in _EXCLUDED_ADAPTERS):
            continue
        # Windows Mobile Hotspot adapter: "192.168.137.1" or "local area connection*"
        hosted = str(address) == "192.168.137.1" or (
            "local area connection" in name and "192.168.137" in str(address)
        ) or ("local area connection" in name and address.packed[0:3] == bytes([192, 168, 137]))
        wireless = any(m in name for m in ("wi-fi", "wifi", "wireless", "wlan", "wlp", "wlo", "wlx")) or name in ("en0", "en1")
        rank, kind = (0, "Windows hotspot") if hosted else (1, "Wi-Fi / hotspot") if wireless else (2, "Local network")
        ranked.append((rank, name, item["address"], {**item, "kind": kind}))
    ranked.sort(key=lambda r: r[:3])
    return [entry[3] for entry in ranked]


_IFACE_CACHE = {"at": -1e9, "items": []}
_IFACE_TTL = 10.0
_IFACE_LOCK = threading.Lock()


def _host_interfaces():
    now = time.monotonic()
    with _IFACE_LOCK:
        if now - _IFACE_CACHE["at"] < _IFACE_TTL:
            return [dict(item) for item in _IFACE_CACHE["items"]]
    items = _select_hotspot_interface(_all_host_interfaces())
    with _IFACE_LOCK:
        _IFACE_CACHE.update(at=time.monotonic(), items=items)
    return [dict(item) for item in items]


def _host_addresses():
    return [item["address"] for item in _host_interfaces()]


def _request_ip(request: web.Request) -> str:
    remote = request.remote or ""
    if ":" in remote and not remote.startswith("::"):
        remote = remote.split(":")[0]
    return remote


def _is_local_host_request(request: web.Request) -> bool:
    remote = _request_ip(request)
    if not remote or remote in ("127.0.0.1", "::1", "localhost"):
        return True
    try:
        remote_ip = ipaddress.ip_address(remote)
        if remote_ip.is_loopback:
            return True
        for iface in _host_interfaces():
            try:
                if remote_ip == ipaddress.ip_address(iface["address"]):
                    return True
            except ValueError:
                continue
    except ValueError:
        pass
    return False


def _require_host_dashboard(request: web.Request):
    if not _is_local_host_request(request):
        raise web.HTTPForbidden(text="This action is only available from the host laptop")


def _require_share_access(request: web.Request, permission: str = "read"):
    perms = _device_permissions(request)
    if not perms.get(permission):
        raise web.HTTPForbidden(text=f"This browser does not have {permission} access to the shared folder")


def _authorize_transfer_write(request: web.Request) -> str:
    device = _effective_device(request)
    perms = _device_permissions(request, device)
    if not perms.get("write"):
        raise web.HTTPForbidden(text="This browser does not have permission to upload files")
    return device["id"] if device else _device_header(request, "X-Device-Id", f"anon-{uuid.uuid4().hex[:8]}")


def _authenticated_device(request: web.Request, device: dict) -> bool:
    if not device:
        return False
    token = _device_header(request, "X-Device-Token")
    token_hash = device.get("token_hash", "")
    return bool(token and token_hash and hmac.compare_digest(
        hashlib.sha256(token.encode("utf-8")).hexdigest(), token_hash
    ))


def _content_disposition(name):
    ascii_name = name.encode("ascii", "replace").decode().replace('"', "_").replace("?", "_")
    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{urllib.parse.quote(name, safe="")}'


def _requester_id(request):
    device = _paired_device(request)
    if device:
        return device["id"]
    supplied = _device_header(request, "id").strip() or request.query.get("did", "")
    if re.fullmatch(r"[A-Za-z0-9_-]{8,80}", supplied or ""):
        return supplied
    return "local-dashboard" if _is_local_host_request(request) else "unknown"


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


