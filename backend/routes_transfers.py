"""
routes_transfers.py — Streaming upload engine, verification, chunk hashing, and job lifecycle.
"""

import asyncio
import errno
import hashlib
import hmac
import os
import re
import threading
import time
import uuid

import aiohttp
from aiohttp import web

from .config import (
    STATE,
    CHUNK_SIZE,
    MAX_CONCURRENT_TRANSFERS,
    MAX_TRANSFERS_PER_DEVICE,
    save_persistent_state,
    request_save,
    record_transfer,
    ACTIVE_SLOT_STATES,
)
from .file_manager import safe_join, sanitize_relative_path, JUNK_NAMES
from .routes_common import *
from .routes_common import (
    _CHUNK_HASHES,
    _ACTIVE_DOWNLOADS,
    FSYNC_MODE,
    OPEN_MODE,
    _json_body,
    _same_target,
    _throttle,
    _expire_stale_jobs,
    _contiguous_chunks,
    _authorize_transfer_write,
    _require_host_dashboard,
    _relative_to_share,
    _is_local_host_request,
)


def _public_transfers(limit=50, device_id=None):
    with STATE["lock"]:
        items = [dict(entry) for entry in STATE["transfers"]]
        share = STATE["share_dir"]
        for job in STATE.get("transfer_jobs", {}).values():
            if job.get("status") == "completed":
                continue
            items.append(
                {
                    "id": job.get("id"),
                    "device_id": job.get("device_id"),
                    "filename": job.get("filename"),
                    "size": job.get("size"),
                    "offset": job.get("offset"),
                    "status": job.get("status"),
                    "timestamp": job.get("created_at"),
                    "updated_at": job.get("updated_at"),
                    "destination": job.get("destination"),
                    "detail": job.get("error", ""),
                    "relative_path": _relative_to_share(job.get("destination", ""), share),
                }
            )
        for dl in _ACTIVE_DOWNLOADS.values():
            items.append({k: v for k, v in dl.items() if k != "stop"})
    if device_id is not None:
        items = [item for item in items if item.get("device_id") == device_id]
    return sorted(items, key=lambda item: item.get("timestamp", item.get("updated_at", 0)))[-limit:]


def _write_chunk(path, offset, data):
    with open(path, "r+b") as out:
        out.seek(offset)
        out.write(data)
        if FSYNC_MODE != "complete":
            out.flush()
            try:
                os.fsync(out.fileno())
            except OSError:
                pass


def _verify_and_hash(path, size, expected, job_dict=None):
    """One sequential pass: whole-file SHA-256 + per-chunk verification + live verified counter."""
    if os.path.getsize(path) != size:
        raise ValueError("Partial file size does not match the declared size")
    if FSYNC_MODE == "complete":
        try:
            with open(path, "r+b") as handle:
                handle.flush()
                os.fsync(handle.fileno())
        except OSError:
            pass
    whole = hashlib.sha256()
    bad = []
    index = 0
    hashed_bytes = 0
    with open(path, "rb") as f:
        while block := f.read(CHUNK_SIZE):
            whole.update(block)
            want = expected.get(index)
            if want and hashlib.sha256(block).hexdigest() != want:
                bad.append(index)
            index += 1
            hashed_bytes += len(block)
            if job_dict is not None and hashed_bytes % (32 * 1024 * 1024) == 0:
                with STATE["lock"]:
                    job_dict["verified"] = hashed_bytes
    if job_dict is not None:
        with STATE["lock"]:
            job_dict["verified"] = hashed_bytes
    return whole.hexdigest(), bad


def _publish(job):
    part = job["part_path"]
    dest = job["destination"]
    if job.get("collision") == "replace":
        os.replace(part, dest)
        return
    try:
        os.link(part, dest)
    except FileExistsError:
        raise
    except OSError:
        if os.path.exists(dest):
            raise FileExistsError(dest)
        os.rename(part, dest)
        return
    try:
        os.remove(part)
    except OSError:
        pass


def _fail(job, message):
    _CHUNK_HASHES.pop(job.get("id"), None)
    with STATE["lock"]:
        if job.get("status") == "cancelled":
            return
        job["status"] = "failed"
        job["error"] = message
        job["updated_at"] = int(time.time())
        try:
            if os.path.exists(job.get("part_path", "")):
                os.remove(job["part_path"])
        except OSError:
            pass
    request_save()


def _available_transfer_space(exclude_job_id=None, existing_allocation=0):
    free_bytes = shutil.disk_usage(STATE["share_dir"]).free
    with STATE["lock"]:
        reserved = sum(
            max(0, int(job.get("size", 0)) - int(job.get("offset", 0)))
            for job_id, job in STATE.get("transfer_jobs", {}).items()
            if job_id != exclude_job_id
            and job.get("status") in {"queued", "transferring", "interrupted", "verifying"}
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
            if job.get("device_id") != device_id or job.get("status") not in {
                "queued",
                "transferring",
                "interrupted",
                "verifying",
            }:
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


def _get_transfer_job(request, job_id):
    device_id = _authorize_transfer_write(request)
    local = _is_local_host_request(request)
    with STATE["lock"]:
        job = STATE.get("transfer_jobs", {}).get(job_id)
        if not job or (not local and job.get("device_id") != device_id):
            raise web.HTTPNotFound(text="Transfer session not found")
        return job


async def create_transfer_handler(request: web.Request) -> web.Response:
    device_id = _authorize_transfer_write(request)
    try:
        body = await _json_body(request)
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
    requested_target = target
    if (
        max(
            len(target),
            len(os.path.join(os.path.dirname(target), ".supershare-" + "0" * 32 + ".partial")),
        )
        > 240
    ):
        raise web.HTTPBadRequest(text="Path is too long for Windows (240 characters max)")

    if resume_id:
        with STATE["lock"]:
            _expire_stale_jobs()
            existing_job = STATE.get("transfer_jobs", {}).get(resume_id)
            if (
                existing_job
                and existing_job.get("device_id") == device_id
                and existing_job.get("size") == size
                and _same_target(existing_job, target)
                and existing_job.get("status") == "completed"
            ):
                return web.json_response(
                    {
                        "id": resume_id,
                        "filename": existing_job["filename"],
                        "offset": size,
                        "chunk_size": CHUNK_SIZE,
                        "status": "completed",
                    }
                )
            if (
                existing_job
                and existing_job.get("device_id") == device_id
                and existing_job.get("size") == size
                and _same_target(existing_job, target)
                and existing_job.get("status") in {"queued", "transferring", "interrupted"}
            ):
                partial_path = existing_job["part_path"]
                if not os.path.exists(partial_path):
                    existing_job["mask"], existing_job["offset"] = "0", 0
                    open(partial_path, "xb").close()
                existing_job["share_root"] = os.path.realpath(STATE["share_dir"])
                try:
                    available = _available_transfer_space(
                        exclude_job_id=resume_id, existing_allocation=existing_job["offset"]
                    )
                    if size > available:
                        raise web.HTTPInsufficientStorage(
                            text="Not enough unreserved space to resume this transfer"
                        )
                except OSError:
                    raise web.HTTPInsufficientStorage(
                        text="The selected receive drive is unavailable"
                    )
                existing_job["status"] = "interrupted"
                existing_job["updated_at"] = int(time.time())
                request_save()
                return web.json_response(
                    {
                        "id": resume_id,
                        "filename": existing_job["filename"],
                        "offset": existing_job["offset"],
                        "chunk_size": CHUNK_SIZE,
                        "status": "interrupted",
                    }
                )
            if (
                existing_job
                and existing_job.get("device_id") == device_id
                and existing_job.get("size") == size
                and _same_target(existing_job, target)
                and existing_job.get("status") == "failed"
                and not os.path.exists(target)
            ):
                active = [
                    j
                    for j in STATE.get("transfer_jobs", {}).values()
                    if j.get("status") in ACTIVE_SLOT_STATES
                ]
                if (
                    len(active) >= MAX_CONCURRENT_TRANSFERS
                    or sum(j.get("device_id") == device_id for j in active)
                    >= MAX_TRANSFERS_PER_DEVICE
                ):
                    raise web.HTTPTooManyRequests(
                        text=f"Transfer limit reached ({MAX_CONCURRENT_TRANSFERS} active jobs).",
                        headers={"Retry-After": "3"},
                    )
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
                        raise web.HTTPInsufficientStorage(
                            text="Not enough unreserved space to restart this transfer"
                        )
                except OSError:
                    raise web.HTTPInsufficientStorage(
                        text="The selected receive drive is unavailable"
                    )
                existing_job["status"] = "queued"
                existing_job["updated_at"] = int(time.time())
                existing_job.pop("error", None)
                request_save()
                return web.json_response(
                    {
                        "id": resume_id,
                        "filename": existing_job["filename"],
                        "offset": 0,
                        "chunk_size": CHUNK_SIZE,
                        "status": "queued",
                    }
                )

    if collision not in {"ask", "skip", "rename", "replace"}:
        raise web.HTTPBadRequest(text="Collision choice must be ask, skip, rename, or replace")

    with STATE["lock"]:
        # Check if target is already reserved by another active job (L12)
        reserved_targets = {
            j.get("destination")
            for j in STATE.get("transfer_jobs", {}).values()
            if j.get("status") in ACTIVE_SLOT_STATES
        }
        if os.path.exists(target) or target in reserved_targets:
            if collision == "ask":
                return web.json_response(
                    {
                        "error": "destination_exists",
                        "filename": os.path.basename(target),
                        "choices": ["skip", "rename", "replace", "cancel"],
                    },
                    status=409,
                )
            if collision == "skip":
                return web.json_response(
                    {"status": "skipped", "filename": os.path.basename(target)}
                )
            if collision == "rename":
                stem, extension = os.path.splitext(target)
                suffix = 1
                while (
                    os.path.exists(f"{stem} ({suffix}){extension}")
                    or f"{stem} ({suffix}){extension}" in reserved_targets
                ):
                    suffix += 1
                target = f"{stem} ({suffix}){extension}"

    try:
        await asyncio.to_thread(os.makedirs, os.path.dirname(target), exist_ok=True)
    except (FileExistsError, NotADirectoryError):
        raise web.HTTPConflict(text="A file already exists where a folder is needed in this path")

    job_id = uuid.uuid4().hex
    part_path = os.path.join(os.path.dirname(target), f".supershare-{job_id}.partial")
    job = {
        "id": job_id,
        "device_id": device_id,
        "filename": os.path.basename(target),
        "destination": target,
        "requested_destination": requested_target,
        "part_path": part_path,
        "size": size,
        "offset": 0,
        "mask": "0",
        "share_root": os.path.realpath(STATE["share_dir"]),
        "collision": collision,
        "status": "queued",
        "created_at": int(time.time()),
        "updated_at": int(time.time()),
    }

    with STATE["lock"]:
        _expire_stale_jobs()
        active = [
            j
            for j in STATE.get("transfer_jobs", {}).values()
            if j.get("status") in ACTIVE_SLOT_STATES
        ]
        if (
            len(active) >= MAX_CONCURRENT_TRANSFERS
            or sum(j.get("device_id") == device_id for j in active) >= MAX_TRANSFERS_PER_DEVICE
        ):
            raise web.HTTPTooManyRequests(
                text=f"Transfer limit reached ({MAX_CONCURRENT_TRANSFERS} active jobs).",
                headers={"Retry-After": "3"},
            )
        try:
            if size > _available_transfer_space():
                raise web.HTTPInsufficientStorage(
                    text="Not enough unreserved space on the receive drive"
                )
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
    return web.json_response(
        {
            "id": job_id,
            "filename": job["filename"],
            "offset": 0,
            "chunk_size": CHUNK_SIZE,
            "status": "queued",
        },
        status=201,
    )


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
    server_hashed = (
        request.headers.get("X-Chunk-Hash-Mode", "").lower() == "server" and not supplied
    )
    if not server_hashed and not re.fullmatch(r"[a-f0-9]{64}", supplied):
        raise web.HTTPBadRequest(text="X-Chunk-SHA256 header is required")

    device_state = STATE["devices"].get(job["device_id"]) or {}
    if device_state.get("paused"):
        raise web.HTTPLocked(
            text="Paused by the host. Sending continues automatically when the host resumes it.",
            headers={"Retry-After": "3"},
        )
    with STATE["lock"]:
        if job["status"] not in {"queued", "transferring", "interrupted"}:
            raise web.HTTPConflict(text=f"Transfer is {job['status']}")
        job["status"], job["updated_at"] = "transferring", int(time.time())

    limit_kbps = int(device_state.get("limit_kbps") or 0)
    buf = bytearray()
    touched = time.monotonic()
    async for piece in request.content.iter_chunked(1024 * 1024):
        buf.extend(piece)
        if len(buf) > expected:
            raise web.HTTPRequestEntityTooLarge(max_size=expected, actual_size=len(buf))
        if limit_kbps:
            await _throttle(job["device_id"], len(piece), limit_kbps)
        if time.monotonic() - touched > 5:
            touched = time.monotonic()
            job["updated_at"] = int(time.time())

    if len(buf) != expected:
        raise web.HTTPBadRequest(text=f"Chunk must contain exactly {expected} bytes at this offset")

    actual = await asyncio.to_thread(lambda: hashlib.sha256(buf).hexdigest())
    if not server_hashed and not hmac.compare_digest(actual, supplied):
        raise web.HTTPUnprocessableEntity(text="Chunk SHA-256 mismatch; resend this chunk")

    try:
        await asyncio.to_thread(_write_chunk, job["part_path"], offset, buf)
    except FileNotFoundError:
        raise web.HTTPConflict(
            text="The partial file is missing on the host; restart this transfer"
        )
    except OSError as exc:
        full = getattr(exc, "errno", None) == errno.ENOSPC
        with STATE["lock"]:
            job["status"] = "interrupted"
            job["error"] = (
                "Receive drive is full" if full else f"Host write failed: {str(exc)[:120]}"
            )
            job["updated_at"] = int(time.time())
        request_save()
        if full:
            raise web.HTTPInsufficientStorage(text=job["error"]) from exc
        raise web.HTTPInternalServerError(text=job["error"]) from exc

    _CHUNK_HASHES.setdefault(job["id"], {})[offset // CHUNK_SIZE] = actual

    with STATE["lock"]:
        if job["status"] not in {"queued", "transferring", "interrupted"}:
            raise web.HTTPConflict(text=f"Transfer is {job['status']}")
        mask = int(job.get("mask", "0"), 16) | (1 << (offset // CHUNK_SIZE))
        job["mask"] = format(mask, "x")
        job["offset"] = min(size, _contiguous_chunks(mask) * CHUNK_SIZE)
        job["updated_at"] = int(time.time())

    return web.json_response({"offset": job["offset"], "status": job["status"]})


async def transfer_status_handler(request: web.Request) -> web.Response:
    job = _get_transfer_job(request, request.match_info["job_id"])
    return web.json_response(
        {
            key: job[key]
            for key in (
                "id",
                "filename",
                "destination",
                "size",
                "offset",
                "status",
                "updated_at",
                "error",
                "verified",
            )
            if key in job
        }
    )


async def complete_transfer_handler(request: web.Request) -> web.Response:
    job = _get_transfer_job(request, request.match_info["job_id"])
    if job["status"] == "completed":
        return web.json_response({"status": "completed", "sha256": job.get("sha256")})
    if job["status"] == "verifying":
        return web.json_response({"status": "verifying"}, status=202)

    size = job["size"]
    total = -(-size // CHUNK_SIZE) if size > 0 else 0
    with STATE["lock"]:
        if size > 0 and int(job.get("mask", "0"), 16) != (1 << total) - 1:
            raise web.HTTPConflict(
                text="Transfer is incomplete; resume from the acknowledged offset"
            )
        if job["status"] not in {"queued", "transferring", "interrupted"}:
            raise web.HTTPConflict(text=f"Transfer is {job['status']}")
        job["status"], job["updated_at"], job["verified"] = "verifying", int(time.time()), 0

    try:
        digest, bad = await asyncio.to_thread(
            _verify_and_hash, job["part_path"], size, dict(_CHUNK_HASHES.get(job["id"], {})), job
        )
        if bad:
            with STATE["lock"]:
                mask = int(job.get("mask", "0"), 16)
                for i in bad:
                    mask &= ~(1 << i)
                    _CHUNK_HASHES.get(job["id"], {}).pop(i, None)
                job.update(
                    mask=format(mask, "x"),
                    offset=min(size, _contiguous_chunks(mask) * CHUNK_SIZE),
                    status="interrupted",
                    updated_at=int(time.time()),
                    error=f"{len(bad)} chunk(s) failed host verification and are being re-sent",
                )
            request_save()
            return web.json_response(
                {"error": "chunks_corrupt", "bad_offsets": [i * CHUNK_SIZE for i in bad]},
                status=409,
            )

        with STATE["lock"]:
            if job["status"] != "verifying":
                raise web.HTTPConflict(
                    text=f"Transfer was {job['status']} before it could be published"
                )
            if os.path.realpath(STATE["share_dir"]) != job.get("share_root"):
                raise web.HTTPConflict(text="Receive root changed; transfer was cancelled")
        await asyncio.to_thread(_publish, job)
    except web.HTTPException:
        raise
    except FileExistsError:
        _fail(job, "A file already exists at this destination")
        raise web.HTTPConflict(text=job["error"])
    except Exception as exc:
        if job.get("status") == "cancelled":
            raise web.HTTPConflict(text=job.get("error", "Transfer was cancelled")) from exc
        _fail(job, f"Could not publish file: {exc}")
        raise web.HTTPInternalServerError(text=job["error"]) from exc

    _CHUNK_HASHES.pop(job["id"], None)
    with STATE["lock"]:
        job.update(status="completed", sha256=digest, updated_at=int(time.time()))
    request_save()
    await asyncio.to_thread(
        record_transfer,
        job["device_id"],
        job["filename"],
        job["size"],
        "completed",
        f"SHA-256 {digest}",
        job["destination"],
    )
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


STALE_PARTIAL_SECONDS = 24 * 3600
