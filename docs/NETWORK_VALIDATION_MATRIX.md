# Network, performance, and accessibility validation matrix

Use one row per tested topology and client combination. Keep the benchmark JSON alongside local ignored `benchmark-results/` output; attach or copy it into release evidence only after review. A loopback result must never be presented as Wi-Fi or hotspot performance.

## Run metadata

| Field | Value |
| --- | --- |
| Run date and operator | Not run on physical devices in this workspace |
| Host OS/build and Python | Windows 11 build 26200 / Python 3.12.6 (loopback run) |
| Host browser/dashboard | Not applicable to benchmark command |
| Client OS/browser/version | Not applicable to benchmark command |
| Topology and internet disabled? | Loopback; internet-offline condition not tested |
| Hotspot/router and client isolation | Not tested |
| Host firewall/profile | Not tested |

## Transfer benchmark evidence

| Path | Payload | Result | Checksum | Cleanup | Resource limits |
| --- | ---: | --- | --- | --- | --- |
| Loopback `127.0.0.1:18765` (latest run) | 4,325,376 bytes, 2 chunks | 0.186 s; 23,223,707 bytes/s (about 23.2 MB/s) | Match: `77b3c9cd84c3bb580e571951b6ce10e5e754bbd00d1740240116253541077871` | Destination removed | Client CPU 0.125 s; client peak RSS 34,521,088 bytes; server CPU/RSS and disk I/O not measured |

Machine-readable result: `benchmark-results/loopback-2026-10-31.json` (ignored local artifact).

## Physical release checks

Status values: **Not run** until physically exercised and recorded; do not infer a pass from source review or loopback checks.

| Area | Required coverage | Status | Evidence / failure details |
| --- | --- | --- | --- |
| Wi-Fi throughput and capacity | Small file, many small files, large file, two concurrent browsers; checksum, throughput, CPU/RSS, disk I/O, UI responsiveness | Not run | Requires a second device and Wi-Fi network |
| Laptop hotspot offline | Internet/mobile data disabled; Android/iOS browsers; pairing via QR/manual URL; client isolation and firewall | Not run | Requires a physical laptop hotspot and phones |
| Transfer recovery | Cancel, low storage, Wi-Fi loss, reload/resume, host restart, collision/replace | Not run | Requires physical browser/network interruption |
| Browser layouts | Phone, tablet, desktop, landscape, narrow viewport | Not run | CSS code review only; no viewport visual review |
| Keyboard and screen reader | Full primary flows, focus order/return, dialog semantics, progress/status announcements | Not run | Requires manual assistive technology review |
| HTTPS | Trusted and untrusted local CA, host mismatch, certificate regeneration | Not run | Requires browser testing against generated local CA |
| Windows packaging | Build, clean install, upgrade, rollback, migration, uninstall/data retention, firewall guidance | Not run | PyInstaller unavailable in the current workspace |

## Benchmark usage

Run from the client that sends the file:

```powershell
python tools/benchmark_transfer.py --host http://HOST-IP:8765 --file PATH --scenario hotspot --output benchmark-results/hotspot-run.json
```

Use `--scenario wifi` or `--scenario loopback` as appropriate. Remote clients must provide the paired `--device-id` and `--cookie`; do not put real credentials in checked-in files. Use distinct files/clients for concurrent runs. The tool records client-side CPU and peak RSS when the platform API provides it; host-side CPU/RSS and disk I/O require external OS monitoring and should be entered with the results. Its throughput covers transfer plus verification time and is not raw link speed.
