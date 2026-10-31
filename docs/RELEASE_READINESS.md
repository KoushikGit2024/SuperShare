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
- Benchmark small files, many files, and multi-gigabyte files on hotspot and Wi-Fi; attach result JSON from `tools/benchmark_transfer.py`. The tool removes its uniquely named output after success unless `--keep-file` is supplied.
- For a remote benchmark, provide the paired device ID and session cookie; the generated default identity is for a local-host diagnostic run.
- Verify packaging/data migration, firewall instructions, clean install, upgrade, rollback, and uninstall on Windows.

## Validation completed in this workspace

- A loopback end-to-end upload through the running aiohttp server succeeded for a 3,579-byte README. Client and server SHA-256 values matched, and the benchmark removed the generated destination file. This is a local smoke check only; its throughput is not a performance result.
- Python source parsing, JavaScript syntax checking, and `git diff --check` passed during the documentation update.
- No physical phone, hotspot, mobile browser, or cross-device network was exercised here. The browser/network release gates above remain open.
