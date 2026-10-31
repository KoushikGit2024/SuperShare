# SuperShare Web-Only Improvement Plan

## Product scope

SuperShare is a browser-operated local-network file-sharing website. A laptop runs the host service and serves the web interface; other devices connect using a browser on the same Wi-Fi or hotspot. No companion Android, desktop, or other client app is required. The host service is still required to provide the local web site, manage permissions, and receive files.

Files are selected by the user through the browser file or folder picker, drag-and-drop, or paste. The browser reads those selected files from their existing locations and streams them to the host; the site does not create a separate source copy. Browser security prevents silent access to arbitrary paths and prevents a normal web page from registering as a system share-sheet target across all browsers.

The initial topology routes transfers through the laptop host. Direct browser-to-browser peer transfer, cloud relays, and remote internet access are outside the first release scope.

## Current implementation

- `run.py` starts the canonical aiohttp server in `backend/`; the website is served from `static/`.
- A laptop-local dashboard manages the shared receive root, device approvals, transfer history, and network information.
- Browser profiles receive local identities and pair with a session code plus a three-word verification phrase. The host grants read and/or send access and can revoke or forget devices.
- A paired browser can browse the approved host root, download files, and upload files/folders after explicit browser selection.
- Upload sessions use bounded chunks, per-chunk SHA-256 checks, server-side re-verification, whole-file hashing, collision handling, cancellation, and resume after the same file is selected again in the same browser profile.
- The server advertises a QR code and local adapter URLs. Browser clients use the QR/manual URL; web pages cannot listen to the host's UDP broadcast.
- Optional local HTTPS is available with `python run.py --https`; browsers must trust the generated local CA. HTTP remains the compatibility default and does not encrypt credentials or file data.
- The host uses one configured receive root. Remote clients cannot change it.

## Remaining work by priority

### 1. Documentation and scope consistency

- Keep README, run guide, protocol, improvement plan, UI copy, and release checklist consistently web-only.
- Explain host versus browser responsibilities, source-file access limits, transfer routing, HTTPS trust, and hotspot/firewall setup.
- Remove obsolete app-only directions and avoid promising browser capabilities that the platform does not provide.

**Acceptance:** users can start, pair, transfer, resume, and troubleshoot using only the host command and a browser.

### 2. Browser and network validation

- Validate the laptop host with desktop and mobile browsers over a hotspot with internet access disabled.
- Cover file/folder selection, multiple files, drag/drop, paste, downloads, large transfers, conflicts, cancellation, low disk, connection loss, reload, resume, and host restart.
- Test hotspot client isolation, Windows Firewall, adapter changes, QR/manual URLs, HTTP, and optional HTTPS trust.
- Record browser/OS versions, network topology, file sizes, results, hashes, and actionable failures.

**Acceptance:** a release matrix shows successful and recovered-failure flows for each supported environment. Anything not physically exercised remains marked unverified.

### 3. Device identity and onboarding

- Make clear that device identity is browser-profile identity, not guaranteed physical hardware identity.
- Show editable device names, browser/platform, last-seen time, pair/approval state, access scope, and recent transfer.
- Make one-time approval, persistent trust, revoke, forget, and permission changes understandable and promptly effective.
- Keep QR and manual URL onboarding reliable when hotspot client isolation or firewalls interfere.

**Acceptance:** the host can identify which browser profile is requesting access and can revoke its credentials immediately.

### 4. Transfer UX and observability

- Replace native browser `prompt()` / `confirm()` calls with accessible in-page dialogs.
- Show each file's source label, sender, destination, phase, bytes, percent, throughput, elapsed time, and reliable ETA.
- Preserve actionable states for queued, waiting for approval, connecting, transferring, verifying, complete, failed, cancelled, and interrupted.
- Explain that resume requires selecting the same file again in the same browser profile.
- Show completed destination and recovery actions; make failures and empty/loading/disconnected states clear.
- Keep all high-impact actions keyboard accessible and announce state changes without overwhelming screen readers.

**Acceptance:** a user can explain the state and next action for every active or failed transfer without reading logs.

### 5. Security and privacy

- Review every API route for pairing, cookie, role, and host-dashboard enforcement, including mutations and downloads.
- Review CSRF protections, cookie lifetime/scope, pairing-code brute-force controls, credential revocation, and path/symlink containment.
- Exercise optional TLS on real browsers, including untrusted CA, wrong host, expired/replaced certificate, and key regeneration.
- Document local state and history retention, partial-file expiry, logs, and credential reset behavior.
- Make the HTTP encryption limitation visible and keep local-only firewall guidance precise.

**Acceptance:** a route-by-route access review and negative-access checks show unauthorized clients cannot read, write, delete, or alter host settings.

### 6. Transfer reliability and storage

- Validate resume on browser reload, Wi-Fi interruption, host restart, receive-root change, and expired sessions.
- Ensure cancel, retry, partial cleanup, and root changes cannot publish incomplete or mismatched data.
- Verify collision behavior and that replace preserves the old file until the new upload verifies.
- Cover zero-byte, very large, unusual-name, duplicate-name, nested-folder, and low-space cases.
- Improve host storage errors and make active/retained partial storage visible.

**Acceptance:** each interrupted job either resumes safely or ends with a clear error and documented cleanup; completed files pass checksum validation.

### 7. Performance and capacity

- Run `tools/benchmark_transfer.py` over loopback, Wi-Fi, and laptop-hotspot paths with small, many, and multi-gigabyte files.
- Compare client/server SHA-256, throughput, CPU, memory, disk I/O, and UI responsiveness.
- Measure concurrent browsers and tune chunk size/concurrency only from results.
- Document supported practical file size and peer counts; avoid claiming unmeasured 100 GB support.

**Acceptance:** saved benchmark results define supported ranges and show no unbounded memory growth or UI freeze.

### 8. Accessibility, responsive UI, and release

- Review phone, tablet, desktop, and landscape layouts.
- Check keyboard-only flow, screen-reader names and announcements, focus order, contrast, dialogs, and progress semantics.
- Keep solid surfaces, zero gradients, zero emoji, SVG icons, and the established semantic status colors.
- Validate Windows packaging, clean installation, upgrade, rollback, data migration, uninstall, firewall guidance, and cache/build artifact ignores.

**Acceptance:** primary workflows work at phone and desktop widths and by keyboard, and a clean Windows release can upgrade/recover without losing user state.

## Explicitly deferred

- Direct peer-to-peer transfer without the laptop host.
- Universal OS share-sheet integration or silent arbitrary-path access from a browser.
- Guaranteed background transfer after closing/suspending the browser tab.
- Cloud relay, internet-facing hosting, Wi-Fi Direct, Bluetooth file transfer, and multi-hop routing.
- Multiple receive roots or per-device destination roots.

These can be reconsidered only with a clear product need and a browser-compatible security design.

## Validation record

Keep a release record with host OS/build, browser and version, client OS, hotspot/router, internet-disabled result, transfer size/type, measured throughput, checksum result, interruptions attempted, and remaining failures. Separate automated/local checks from tests that require physical devices or a real hotspot.
