"""
routes_files.py — Shared directory navigation, file explorer APIs, previews, and Range-supported download streaming.
"""
import asyncio
import os
import re
import stat as _stat
import time
import urllib.parse
import uuid

from aiohttp import web

from .config import (
    STATE, save_persistent_state, record_transfer,
)
from .file_manager import (
    safe_join, list_directory, list_host_folders, delete_selected_items, sanitize_relative_path,
)
from .routes_transfers import _cancel_active_transfer_jobs
from .routes_common import *
from .routes_common import (
    _ACTIVE_DOWNLOADS, _json_body, _device_header, _device_permissions,
    _require_share_access, _require_host_dashboard, _relative_to_share, _throttle,
    _requester_id,
)


def _begin_download(device_id, filename, size):
    now = int(time.time())
    job = {"id": "dl-" + uuid.uuid4().hex, "device_id": device_id, "filename": filename,
           "size": size, "offset": 0, "status": "transferring", "timestamp": now,
           "updated_at": now, "direction": "send", "detail": "Sending to browser", "stop": False}
    with STATE["lock"]:
        _ACTIVE_DOWNLOADS[job["id"]] = job
    return job

def _end_download(job, status, detail=""):
    with STATE["lock"]:
        _ACTIVE_DOWNLOADS.pop(job["id"], None)
    record_transfer(job["device_id"], job["filename"], job["offset"], status,
                    detail or ("Sent to browser" if status == "completed" else "Download did not finish"),
                    job["device_id"], "send")

FSYNC_MODE = os.environ.get("SUPERSHARE_FSYNC", "chunk").lower()  # "chunk" (default, safest) or "complete"

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
    body = await _json_body(request)
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
    body = await _json_body(request)
    rel_path = body.get("path", "")
    target = safe_join(STATE["share_dir"], rel_path)
    os.makedirs(target, exist_ok=True)
    return web.json_response({"status": "ok"})

async def delete_selected_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    body = await _json_body(request)
    items = body.get("items", [])
    res = await asyncio.to_thread(delete_selected_items, STATE["share_dir"], items)
    return web.json_response({"status": "ok", "deleted": res.get("deleted", 0), "failed": res.get("failed", [])})

async def preview_file_handler(request: web.Request) -> web.Response:
    _require_share_access(request)
    target = safe_join(STATE["share_dir"], request.query.get("path", ""))
    if not os.path.isfile(target):
        raise web.HTTPNotFound(text="File not found")
    name = os.path.basename(target)
    # Check mime type
    import mimetypes
    mime, _ = mimetypes.guess_type(target)
    mime = mime or "application/octet-stream"
    # Text-based types
    ext = os.path.splitext(name)[1].lower()
    text_extensions = {".txt", ".md", ".py", ".js", ".json", ".html", ".css", ".csv", ".log", ".xml", ".sh", ".ps1", ".yaml", ".yml", ".ini"}
    if ext in text_extensions:
        mime = "text/plain; charset=utf-8"

    return web.FileResponse(target, headers={
        "Content-Type": mime,
        "Content-Disposition": f'inline; filename="{urllib.parse.quote(name)}"',
        "Cache-Control": "public, max-age=3600",
    })

async def download_handler(request: web.Request) -> web.StreamResponse:
    _require_share_access(request)
    target = safe_join(STATE["share_dir"], request.query.get("path", ""))
    if not os.path.isfile(target):
        raise web.HTTPNotFound(text="File not found")
    name = os.path.basename(target)
    size = os.path.getsize(target)
    start, end, status = 0, size - 1, 200
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", request.headers.get("Range", "").strip())
    if size and match and (match.group(1) or match.group(2)):
        if match.group(1):
            start = int(match.group(1))
            end = int(match.group(2)) if match.group(2) else size - 1
        else:
            start, end = max(0, size - int(match.group(2))), size - 1
        end = min(end, size - 1)
        if start > end:
            raise web.HTTPRequestedRangeNotSatisfiable(headers={"Content-Range": f"bytes */{size}"})
        status = 206
    length = max(0, end - start + 1)
    headers = {"Content-Type": "application/octet-stream", "Content-Length": str(length),
               "Accept-Ranges": "bytes", "Content-Disposition": _content_disposition(name),
               "Cache-Control": "no-store"}
    if status == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"

    device_id = _requester_id(request)
    limit_kbps = int((STATE["devices"].get(device_id) or {}).get("limit_kbps") or 0)
    resp = web.StreamResponse(status=status, headers=headers)
    await resp.prepare(request)
    job = _begin_download(device_id, name, length)
    try:
        with open(target, "rb") as source:
            source.seek(start)
            remaining = length
            while remaining > 0:
                if job["stop"]:
                    _end_download(job, "cancelled", "Stopped by the host")
                    return resp
                block = await asyncio.to_thread(source.read, min(1024 * 1024, remaining))
                if not block:
                    break
                if limit_kbps:
                    await _throttle(device_id, len(block), limit_kbps)
                await resp.write(block)
                remaining -= len(block)
                job["offset"] += len(block)
                job["updated_at"] = int(time.time())
        await resp.write_eof()
        _end_download(job, "completed")
    except (asyncio.CancelledError, *DISCONNECT_ERRORS):
        _end_download(job, "cancelled", "Browser stopped the download")
        raise
    except OSError as exc:
        _end_download(job, "failed", f"Host could not read the file: {exc.strerror}")
        raise
    return resp

async def download_stop_handler(request: web.Request) -> web.Response:
    _require_host_dashboard(request)
    body = await _json_body(request)
    job = _ACTIVE_DOWNLOADS.get(str(body.get("id", "")))
    if not job:
        raise web.HTTPNotFound(text="Download is no longer active")
    job["stop"] = True
    return web.json_response({"status": "ok"})
