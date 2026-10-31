"""
api_routes.py — aiohttp REST and streaming endpoints for SuperShare.
"""
import os
import json
import asyncio
import urllib.parse
import re
import time
from aiohttp import web

from .config import STATE, CHUNK_SIZE, save_persistent_state, record_transfer
from .file_manager import (
    safe_join,
    list_directory,
    list_host_folders,
    build_folder_zip,
    build_multi_selection_zip,
    delete_selected_items,
)


async def status_handler(request: web.Request) -> web.Response:
    device_id = request.headers.get("X-SuperShare-Device", "").strip()
    if device_id:
        _touch_device(device_id, request.headers.get("X-SuperShare-Name", "Unknown device"),
                      request.headers.get("X-SuperShare-Type", "Device"), request.remote)
    return web.json_response({
        "status": "online",
        "server": "SuperShare",
        "share_root": STATE["share_dir"],
        "host_name": os.environ.get("COMPUTERNAME") or (os.uname().nodename if hasattr(os, "uname") else "SuperShare host"),
        "devices": _public_devices(),
        "transfers": STATE["transfers"][-50:],
    })


def _touch_device(device_id, name, device_type, remote):
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", device_id):
        return
    with STATE["lock"]:
        old = STATE["devices"].get(device_id, {})
        STATE["devices"][device_id] = {
            "id": device_id,
            "name": (name or "Unknown device")[:80],
            "type": (device_type or "Device")[:40],
            "ip": remote or old.get("ip", ""),
            "first_seen": old.get("first_seen", int(time.time())),
            "last_seen": int(time.time()),
            "online": True,
            "trusted": old.get("trusted", False),
        }
    save_persistent_state()


def _public_devices():
    now = int(time.time())
    with STATE["lock"]:
        result = []
        for device in STATE["devices"].values():
            item = dict(device)
            item["online"] = now - item.get("last_seen", 0) < 25
            result.append(item)
        return sorted(result, key=lambda d: (not d["online"], d["name"].lower()))


async def devices_handler(request: web.Request) -> web.Response:
    return web.json_response({"devices": _public_devices(), "transfers": STATE["transfers"][-50:]})


async def rename_device_handler(request: web.Request) -> web.Response:
    body = await request.json()
    device_id = body.get("id", "")
    name = str(body.get("name", "")).strip()[:80]
    with STATE["lock"]:
        device = STATE["devices"].get(device_id)
        if not device or not name:
            raise web.HTTPBadRequest(text="Device and non-empty name are required")
        device["name"] = name
    save_persistent_state()
    return web.json_response({"status": "ok"})


async def forget_device_handler(request: web.Request) -> web.Response:
    body = await request.json()
    with STATE["lock"]:
        STATE["devices"].pop(body.get("id", ""), None)
    save_persistent_state()
    return web.json_response({"status": "ok"})


async def approve_device_handler(request: web.Request) -> web.Response:
    body = await request.json()
    with STATE["lock"]:
        device = STATE["devices"].get(body.get("id", ""))
        if not device:
            raise web.HTTPNotFound(text="Device not found")
        if body.get("remember"):
            device["trusted"] = True
            device.pop("approved_until", None)
        else:
            device["approved_until"] = int(time.time()) + 15 * 60
    save_persistent_state()
    return web.json_response({"status": "ok"})


async def list_files_handler(request: web.Request) -> web.Response:
    rel_path = request.query.get("path", "")
    share_dir = STATE["share_dir"]
    items = await asyncio.to_thread(list_directory, share_dir, rel_path)
    return web.json_response({
        "share_root": share_dir,
        "current_path": rel_path,
        "items": items
    })


async def host_folders_handler(request: web.Request) -> web.Response:
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
    try:
        selected = await asyncio.to_thread(_open_tk_folder_picker, STATE["share_dir"])
        if selected and os.path.isdir(selected):
            STATE["share_dir"] = os.path.abspath(selected)
            print(f"[FOLDER] Active shared folder switched to: {STATE['share_dir']}")
        return web.json_response({"status": "ok", "share_root": STATE["share_dir"]})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=400)


async def set_share_dir_handler(request: web.Request) -> web.Response:
    body = await request.json()
    new_dir = body.get("share_dir", "").strip()
    if not new_dir or not os.path.isdir(new_dir):
        return web.json_response({"status": "error", "message": "Invalid directory path"}, status=400)
    STATE["share_dir"] = os.path.abspath(new_dir)
    print(f"[FOLDER] Active shared folder switched to: {STATE['share_dir']}")
    return web.json_response({"status": "ok", "share_root": STATE["share_dir"]})


async def mkdir_handler(request: web.Request) -> web.Response:
    body = await request.json()
    rel_path = body.get("path", "")
    target = safe_join(STATE["share_dir"], rel_path)
    os.makedirs(target, exist_ok=True)
    return web.json_response({"status": "ok"})


async def delete_selected_handler(request: web.Request) -> web.Response:
    body = await request.json()
    items = body.get("items", [])
    deleted = await asyncio.to_thread(delete_selected_items, STATE["share_dir"], items)
    print(f"[DELETE] Removed {deleted} item(s)")
    return web.json_response({"status": "ok", "deleted": deleted})


async def download_handler(request: web.Request) -> web.StreamResponse:
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
    rel_path = request.query.get("path", "")
    tmp_zip, zip_filename = await asyncio.to_thread(build_folder_zip, STATE["share_dir"], rel_path)
    return await _stream_and_remove_zip(request, tmp_zip, zip_filename)


async def zip_selected_handler(request: web.Request) -> web.StreamResponse:
    items_raw = request.query.get("items", "[]")
    rel_paths = json.loads(urllib.parse.unquote(items_raw))
    tmp_zip, zip_filename = await asyncio.to_thread(build_multi_selection_zip, STATE["share_dir"], rel_paths)
    return await _stream_and_remove_zip(request, tmp_zip, zip_filename)


async def upload_handler(request: web.Request) -> web.Response:
    raw_rel = request.headers.get("X-File-Path", "uploaded_file.bin")
    rel_path = urllib.parse.unquote(raw_rel)
    target = safe_join(STATE["share_dir"], rel_path)
    os.makedirs(os.path.dirname(target), exist_ok=True)

    device_id = request.headers.get("X-SuperShare-Device", "")
    if device_id:
        _touch_device(device_id, request.headers.get("X-SuperShare-Name", "Unknown device"),
                      request.headers.get("X-SuperShare-Type", "Device"), request.remote)
        with STATE["lock"]:
            device = STATE["devices"].get(device_id, {})
            approved = device.get("trusted", False) or device.get("approved_until", 0) > int(time.time())
        if not approved:
            raise web.HTTPForbidden(text="This device needs approval before sending files")
    print(f"[UPLOAD] Receiving -> {rel_path}")
    received = 0
    try:
        with open(target, "wb") as f:
            async for chunk in request.content.iter_chunked(CHUNK_SIZE):
                await asyncio.to_thread(f.write, chunk)
                received += len(chunk)
    except Exception as exc:
        record_transfer(device_id, os.path.basename(target), received, "failed", str(exc)[:200])
        raise
    print(f"[SAVED]  {target}")
    record_transfer(device_id, os.path.basename(target), received)
    return web.json_response({"status": "ok", "bytes": received})
