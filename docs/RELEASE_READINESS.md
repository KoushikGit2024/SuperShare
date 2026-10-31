# Release readiness

## Windows host packaging

`package_windows.ps1` builds a console-hosted PyInstaller executable and bundles the canonical `static/` assets. The frozen app stores its share root and SQLite database under `%LOCALAPPDATA%\SuperShare`; source runs keep data in the repository directory. Firewall setup remains a deliberate manual Windows action.

Build from a Windows environment with project requirements, PyInstaller, and a compatible Python installation. Review antivirus and SmartScreen behavior on a clean Windows machine before distributing the binary.

## Diagnostics

The laptop dashboard reports candidate local IPv4 addresses, service port, protocol version, receive-root free space, and whether its local API is reachable. It does not change firewall settings or expose file contents. `python run.py --https` enables a user-local CA and TLS host certificate; verify the terminal fingerprint and trust the CA in each browser. The host emits UDP discovery announcements on port 8766, which ordinary web pages cannot receive; hotspot client isolation and firewall reachability still need hands-on validation.

## Release gates still open

- Validate browser clients on Windows, Android, and iOS over a hotspot with internet/mobile data disabled.
- Validate QR/manual URL onboarding on representative hotspots; browser-only clients cannot consume the host UDP discovery beacon.
- Exercise the optional local TLS mode on a clean Windows host and browser clients, including certificate regeneration and trust failures.
- Test file and folder selection, drag-and-drop, paste, multiple files, background tab behavior, low storage, and resume across supported browsers.
- Benchmark small files, many files, and multi-gigabyte files on hotspot and Wi-Fi; attach result JSON from `tools/benchmark_transfer.py`. The tool removes its uniquely named output after a successful run and attempts to cancel an unfinished session on failure unless `--keep-file` is supplied.
- For a remote benchmark, provide the paired device ID and session cookie; the generated default identity is for a local-host diagnostic run.
- Verify packaging/data migration, firewall instructions, clean install, upgrade, rollback, and uninstall on Windows.
- Install PyInstaller in the Windows build environment before running `package_windows.ps1`; it is not installed in this workspace.
- Record browser, screen reader, keyboard-only, responsive viewport, and reduced-motion results in `docs/NETWORK_VALIDATION_MATRIX.md` before release.

## Validation completed in this workspace

- A loopback end-to-end upload through the running aiohttp server succeeded for a 3,579-byte README. Client and server SHA-256 values matched, and the benchmark removed the generated destination file. This is a local smoke check only; its throughput is not a performance result.
- After bounded chunk reads and storage reservation changes, a 4,325,376-byte loopback upload crossed the 4 MiB chunk boundary successfully. Client/server SHA-256 matched and the generated destination was removed. This checks local chunk handling, not hotspot or Wi-Fi throughput.
- Repeated after local-dashboard request hardening: a 4,325,376-byte loopback upload succeeded with matching SHA-256 (`bdeb40b8593f6548818afbe9d55b473ebf371e7d430ce0ee37cc1e89a234c69b`) and destination cleanup. Measured loopback throughput was about 19.2 MB/s and is not a network performance claim.
- Updated benchmark tooling and repeated loopback check: 4,325,376 bytes, two chunks, matching client/server SHA-256 (`29ae742d9999d60c5cd91fbffcbcd773a3e08042bd83332bb72c31e7b4c4cdfc`), destination cleanup confirmed, about 18.8 MB/s. This is loopback only; client peak RSS was unavailable on Windows and server resource use was not measured.
- Benchmark JSON was saved to the ignored `benchmark-results/loopback-2026-10-31.json` artifact. The JSON includes scenario, client OS/Python, elapsed and chunk timings, client process CPU, optional client peak RSS, checksums, and cleanup status.
- Latest refreshed loopback run (supersedes earlier same-size loopback figures): 4,325,376 bytes, 2 chunks, 0.186 s, 23,223,707 bytes/s, checksum match (`77b3c9cd84c3bb580e571951b6ce10e5e754bbd00d1740240116253541077871`), cleanup confirmed, client process CPU 0.125 s, client peak RSS 34,521,088 bytes. Server resource use was not measured.
- Accessibility code review added visible focus styling for inputs/selects/drop target, reduced-motion handling, small-screen layout rules, and reduced live announcements for per-chunk progress. Keyboard and screen-reader behavior has not been manually exercised.
- Windows packaging was not run because PyInstaller is unavailable. The packaging script's dependency failure path is documented; clean install/upgrade/rollback/uninstall remain unverified.
- Python source parsing, JavaScript syntax checking, and `git diff --check` passed during the documentation update.
- No physical phone, hotspot, mobile browser, or cross-device network was exercised here. The browser/network release gates above remain open.
