"""Measure a real SuperShare upload over the current local network.

Example: python tools/benchmark_transfer.py --host http://192.168.137.1:8765 --file large.bin
Run on a paired sender that already has the supershare_token cookie, or on the host itself.
"""

import argparse
import hashlib
import json
import platform
import statistics
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

CHUNK_SIZE = 4 * 1024 * 1024


def request(url, method="GET", body=None, headers=None):
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            return (
                json.loads(response.read() or b"{}")
                if response.headers.get("Content-Type", "").startswith("application/json")
                else response.read()
            )
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"{exc.code}: {exc.read().decode(errors='replace')}") from exc


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True, help="SuperShare base URL")
    parser.add_argument("--file", required=True, type=Path)
    parser.add_argument("--device-id", default=f"benchmark-{uuid.uuid4().hex[:12]}")
    parser.add_argument("--cookie", default="", help="Optional supershare_token cookie value")
    parser.add_argument("--output", type=Path, help="Optional JSON results path")
    parser.add_argument(
        "--scenario", default="unspecified", help="Label the path: loopback, Wi-Fi, or hotspot"
    )
    parser.add_argument(
        "--keep-file",
        action="store_true",
        help="Keep the generated benchmark file in the selected host folder",
    )
    args = parser.parse_args()
    path = args.file.resolve(strict=True)
    size = path.stat().st_size
    base = args.host.rstrip("/")
    headers = {
        "X-Device-Id": args.device_id,
        "X-Device-Name": "SuperShare benchmark",
        "X-Device-Platform": "Benchmark",
    }
    if args.cookie:
        headers["Cookie"] = f"supershare_token={args.cookie}"
    destination = f"benchmark-{uuid.uuid4().hex[:10]}-{path.name}"
    transfer_id = None
    completed = None
    cleanup_error = None
    transfer_error = None
    digest = hashlib.sha256()
    chunk_times = []
    sent = 0
    started = time.perf_counter()
    cpu_started = time.process_time()
    try:
        session = request(
            f"{base}/api/transfers",
            "POST",
            json.dumps({"name": path.name, "size": size, "path": destination}).encode(),
            {**headers, "Content-Type": "application/json"},
        )
        transfer_id = session["id"]
        chunk_size = session.get("chunk_size", CHUNK_SIZE)
        with path.open("rb") as source:
            while chunk := source.read(chunk_size):
                digest.update(chunk)
                chunk_hash = hashlib.sha256(chunk).hexdigest()
                chunk_started = time.perf_counter()
                request(
                    f"{base}/api/transfers/{transfer_id}/chunk",
                    "PUT",
                    chunk,
                    {**headers, "X-Chunk-Offset": str(sent), "X-Chunk-SHA256": chunk_hash},
                )
                chunk_times.append(time.perf_counter() - chunk_started)
                sent += len(chunk)
        completed = request(
            f"{base}/api/transfers/{transfer_id}/complete",
            "POST",
            b"{}",
            {**headers, "Content-Type": "application/json"},
        )
    except Exception as exc:
        transfer_error = str(exc)
    finally:
        if transfer_id and not completed:
            try:
                request(f"{base}/api/transfers/{transfer_id}/cancel", "POST", b"{}", headers)
            except Exception:
                pass
        if not args.keep_file:
            try:
                request(
                    f"{base}/api/delete-selected",
                    "POST",
                    json.dumps({"items": [destination]}).encode(),
                    {**headers, "Content-Type": "application/json"},
                )
            except Exception as exc:
                cleanup_error = str(exc)
    elapsed = time.perf_counter() - started
    client_digest = digest.hexdigest()
    server_digest = completed.get("sha256") if completed else None
    result = {
        "host": base,
        "file": path.name,
        "destination": destination,
        "bytes": size,
        "seconds": round(elapsed, 3),
        "bytes_per_second": round(size / elapsed) if elapsed else 0,
        "chunk_size": CHUNK_SIZE,
        "chunk_count": len(chunk_times),
        "chunk_seconds_median": round(statistics.median(chunk_times), 4) if chunk_times else 0,
        "chunk_seconds_max": round(max(chunk_times), 4) if chunk_times else 0,
        "sha256": client_digest,
        "server_sha256": server_digest,
        "checksum_match": bool(server_digest and client_digest == server_digest),
        "scenario": args.scenario,
        "client_platform": platform.platform(),
        "python": sys.version.split()[0],
        "client_process_cpu_seconds": round(time.process_time() - cpu_started, 3),
        "process_peak_rss_bytes": _peak_rss_bytes(),
        "cleaned_up": not args.keep_file and cleanup_error is None,
        "cleanup_error": cleanup_error,
        "transfer_error": transfer_error,
    }
    print(json.dumps(result, indent=2))
    if args.output:
        args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    if not result["checksum_match"]:
        raise SystemExit(
            transfer_error or "Transfer checksum verification failed; see result above"
        )
    if cleanup_error:
        raise SystemExit("Benchmark destination cleanup failed; see cleanup_error above")


def _peak_rss_bytes():
    """Return process peak RSS when the standard-library resource API exists."""
    try:
        import psutil

        memory = psutil.Process().memory_info()
        peak_working_set = getattr(memory, "peak_wset", None)
        if peak_working_set is not None:
            return int(peak_working_set)
    except (ImportError, OSError):
        pass
    try:
        import resource

        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(peak if sys.platform == "darwin" else peak * 1024)
    except (ImportError, AttributeError, OSError):
        return None


if __name__ == "__main__":
    main()
