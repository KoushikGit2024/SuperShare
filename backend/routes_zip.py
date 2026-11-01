"""
routes_zip.py — Streaming and preflight ZIP archive generation for folders and multi-selection downloads.
"""

import asyncio
import os
import queue
import re
import stat as _stat
import threading
import time
import urllib.parse
import zipfile

from aiohttp import web

from .config import (
    STATE,
    record_transfer,
)
from .file_manager import (
    safe_join,
    build_folder_zip,
    build_multi_selection_zip,
    sanitize_relative_path,
)
from .routes_common import *
from .routes_common import (
    DISCONNECT_ERRORS,
    _json_body,
    _device_header,
    _device_permissions,
    _require_share_access,
    _effective_device,
    _paired_device,
    _is_local_host_request,
    _PipeWriter,
)
from .routes_files import _content_disposition, _begin_download, _end_download


def iter_zip_entries(base, rel_paths):
    base_real = os.path.normcase(os.path.realpath(base))

    def inside(p):
        try:
            return (
                os.path.commonpath([base_real, os.path.normcase(os.path.realpath(p))]) == base_real
            )
        except ValueError:
            return False

    for rel in rel_paths:
        target = safe_join(base, rel)
        if os.path.isfile(target):
            yield target, os.path.basename(target)
        elif os.path.isdir(target):
            top = os.path.basename(target) or "shared"
            for root, dirs, files in os.walk(target):
                dirs[:] = [
                    d
                    for d in dirs
                    if not d.startswith(".supershare-") and inside(os.path.join(root, d))
                ]
                for f in files:
                    full = os.path.join(root, f)
                    if f.startswith((".supershare-", ".temp_")) or not inside(full):
                        continue
                    yield full, os.path.join(top, os.path.relpath(full, target))


def _zip_add(zf, path, arc):
    st = os.stat(path)
    stamp = time.localtime(min(max(st.st_mtime, 315532800), 4354819199))[:6]
    info = zipfile.ZipInfo(arc, stamp)
    info.compress_type = zipfile.ZIP_STORED
    info.external_attr = (_stat.S_IMODE(st.st_mode) & 0xFFFF) << 16
    info.file_size = st.st_size
    with open(path, "rb") as src, zf.open(info, "w", force_zip64=st.st_size >= 0xFFFFFFFF) as dst:
        shutil.copyfileobj(src, dst, 1024 * 1024)


def _requester_id(request):
    device = _paired_device(request)
    if device:
        return device["id"]
    supplied = _device_header(request, "id").strip() or request.query.get("did", "")
    if re.fullmatch(r"[A-Za-z0-9_-]{8,80}", supplied or ""):
        return supplied
    return "local-dashboard" if _is_local_host_request(request) else "unknown"


async def _stream_zip(request, rel_paths, zip_name):
    base = STATE["share_dir"]
    entries = await asyncio.to_thread(lambda: list(iter_zip_entries(base, rel_paths)))
    if not entries:
        raise web.HTTPConflict(text="Nothing to download: the selection contains no files")
    q = queue.Queue(maxsize=16)
    stop = threading.Event()
    skipped = []

    def put(item):
        while not stop.is_set():
            try:
                q.put(item, timeout=1)
                return
            except queue.Full:
                continue

    def produce():
        try:
            with zipfile.ZipFile(
                _PipeWriter(q, stop), "w", zipfile.ZIP_STORED, allowZip64=True
            ) as zf:
                for path, arc in entries:
                    if stop.is_set():
                        return
                    try:
                        _zip_add(zf, path, arc)
                    except (OSError, ValueError) as exc:
                        skipped.append(f"{arc}: {getattr(exc, 'strerror', None) or exc}")
                if skipped:
                    zf.writestr(
                        "_SKIPPED_FILES.txt",
                        "These files could not be read:\n" + "\n".join(skipped),
                    )
            put(None)
        except BaseException as exc:
            put(exc)

    resp = web.StreamResponse(
        headers={
            "Content-Type": "application/zip",
            "Content-Disposition": _content_disposition(zip_name),
            "Cache-Control": "no-store",
        }
    )
    await resp.prepare(request)
    device_id = _requester_id(request)
    est = 0
    for path, _arc in entries:
        try:
            est += os.path.getsize(path)
        except OSError:
            pass
    job = _begin_download(device_id, zip_name, est)
    worker = asyncio.create_task(asyncio.to_thread(produce))
    status, detail = "cancelled", "Browser stopped the download"
    all_sent = False
    try:
        while True:
            if job["stop"]:
                detail = "Stopped by the host"
                return resp
            try:
                item = await asyncio.to_thread(q.get, True, 1)
            except queue.Empty:
                if worker.done():
                    break
                continue
            if item is None:
                all_sent = True
                break
            if isinstance(item, BaseException):
                raise item
            try:
                await resp.write(item)
            except DISCONNECT_ERRORS:
                detail = f"Connection closed after {job['offset']:,} bytes"
                return resp
            job["offset"] += len(item)
            job["updated_at"] = int(time.time())
        await resp.write_eof()
        status, detail = "completed", ""
    except DISCONNECT_ERRORS:
        if all_sent:
            status, detail = "completed", "All data sent; browser closed the connection at the end"
        else:
            detail = f"Connection closed after {job['offset']:,} bytes"
    except asyncio.CancelledError:
        if all_sent:
            status, detail = "completed", "All data sent; browser closed the connection at the end"
        else:
            detail = f"Connection closed after {job['offset']:,} bytes"
        raise
    except Exception as exc:
        status, detail = "failed", f"ZIP stream failed: {str(exc)[:120]}"
    finally:
        stop.set()
        _end_download(job, status, detail)
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
_PAIRING_WORDS = (
    "amber",
    "birch",
    "cobalt",
    "delta",
    "ember",
    "fern",
    "granite",
    "harbor",
    "indigo",
    "juniper",
    "kepler",
    "linen",
    "maple",
    "north",
    "onyx",
    "pepper",
    "quartz",
    "river",
    "silver",
    "timber",
    "umber",
    "violet",
    "willow",
    "xenon",
    "yellow",
    "zephyr",
)


async def _stream_and_remove_zip(
    request: web.Request, tmp_zip: str, zip_filename: str
) -> web.StreamResponse:
    device_id = _requester_id(request)
    sent = 0
    try:
        zip_size = os.path.getsize(tmp_zip)
        resp = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "application/zip",
                "Content-Disposition": f'attachment; filename="{urllib.parse.quote(zip_filename)}"',
                "Content-Length": str(zip_size),
            },
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
        record_transfer(
            device_id,
            zip_filename,
            zip_size,
            detail="Sent ZIP to connected device",
            destination=device_id,
            direction="send",
        )
        return resp
    except Exception as exc:
        record_transfer(
            device_id,
            zip_filename,
            sent,
            status="failed",
            detail=f"ZIP download interrupted: {str(exc)[:140]}",
            destination=device_id,
            direction="send",
        )
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
    try:
        items = json.loads(request.query.get("items", "[]"))
        if not (
            isinstance(items, list) and len(items) <= 500 and all(isinstance(i, str) for i in items)
        ):
            raise ValueError
    except ValueError:
        raise web.HTTPBadRequest(text="Invalid selection")
    return await _stream_zip(request, items, f"supershare_selected_{len(items)}.zip")


async def zip_preflight_handler(request: web.Request) -> web.Response:
    _require_share_access(request)
    if "items" in request.query:
        try:
            items = json.loads(request.query.get("items", "[]"))
            if not (
                isinstance(items, list)
                and len(items) <= 500
                and all(isinstance(i, str) for i in items)
            ):
                raise ValueError
        except ValueError:
            raise web.HTTPBadRequest(text="Invalid selection")
    else:
        items = [request.query.get("path", "")]

    def scan():
        files = total = 0
        for full, _arc in iter_zip_entries(STATE["share_dir"], items):
            files += 1
            try:
                total += os.path.getsize(full)
            except OSError:
                pass
            if files >= 200000:
                break
        return files, total

    files, total = await asyncio.to_thread(scan)
    return web.json_response({"files": files, "bytes": total, "empty": files == 0})
