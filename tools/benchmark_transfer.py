"""Measure a real SuperShare upload over the current local network.

Example: python tools/benchmark_transfer.py --host http://192.168.137.1:8765 --file large.bin
Run on a paired sender that already has the supershare_token cookie, or on the host itself.
"""
import argparse
import hashlib
import json
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
            return json.loads(response.read() or b"{}") if response.headers.get("Content-Type", "").startswith("application/json") else response.read()
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"{exc.code}: {exc.read().decode(errors='replace')}") from exc


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True, help="SuperShare base URL")
    parser.add_argument("--file", required=True, type=Path)
    parser.add_argument("--device-id", default=f"benchmark-{uuid.uuid4().hex[:12]}")
    parser.add_argument("--cookie", default="", help="Optional supershare_token cookie value")
    parser.add_argument("--output", type=Path, help="Optional JSON results path")
    parser.add_argument("--keep-file", action="store_true", help="Keep the generated benchmark file in the selected host folder")
    args = parser.parse_args()
    path = args.file.resolve(strict=True)
    size = path.stat().st_size
    base = args.host.rstrip("/")
    headers = {"X-SuperShare-Device": args.device_id, "X-SuperShare-Name": "SuperShare benchmark", "X-SuperShare-Type": "Benchmark"}
    if args.cookie:
        headers["Cookie"] = f"supershare_token={args.cookie}"
    destination = f"benchmark-{uuid.uuid4().hex[:10]}-{path.name}"
    session = request(f"{base}/api/transfers", "POST", json.dumps({"name": path.name, "size": size, "path": destination}).encode(), {**headers, "Content-Type": "application/json"})
    transfer_id = session["id"]
    digest = hashlib.sha256()
    started = time.perf_counter()
    sent = 0
    with path.open("rb") as source:
        while chunk := source.read(CHUNK_SIZE):
            digest.update(chunk)
            chunk_hash = hashlib.sha256(chunk).hexdigest()
            request(f"{base}/api/transfers/{transfer_id}/chunk", "PUT", chunk, {**headers, "X-Chunk-Offset": str(sent), "X-Chunk-SHA256": chunk_hash})
            sent += len(chunk)
    completed = request(f"{base}/api/transfers/{transfer_id}/complete", "POST", b"{}", {**headers, "Content-Type": "application/json"})
    elapsed = time.perf_counter() - started
    if not args.keep_file:
        request(f"{base}/api/delete-selected", "POST", json.dumps({"items": [destination]}).encode(), {**headers, "Content-Type": "application/json"})
    result = {"host": base, "file": path.name, "destination": destination, "bytes": size, "seconds": round(elapsed, 3),
              "bytes_per_second": round(size / elapsed) if elapsed else 0,
              "sha256": digest.hexdigest(), "server_sha256": completed.get("sha256"),
              "checksum_match": digest.hexdigest() == completed.get("sha256"), "chunk_size": CHUNK_SIZE,
              "cleaned_up": not args.keep_file}
    print(json.dumps(result, indent=2))
    if args.output:
        args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
