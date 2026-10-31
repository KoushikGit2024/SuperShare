# SuperShare Improvement Plan

## Product direction

Build SuperShare as a private, local-network transfer system that works when the laptop hotspot has no internet access. A user should be able to identify each nearby device, decide which devices may send or receive, choose a destination, and understand exactly what is happening to every transfer. Files should stream from their current source where the platform allows it; SuperShare should not require users to stage files in a special folder.

The first supported setup is a Windows laptop host and an Android peer on the same hotspot. The Android client can send files from system shares or the document picker to the laptop and can browse/download approved laptop files to a phone document-provider destination. Direct peer-to-peer device routing is not implemented.

## Current state

- The primary runtime is `run.py` plus the `backend/` aiohttp application.
- Both supported launch paths use the same backend and canonical `static/` UI; `app.server` is a compatibility import.
- Browser profiles and the Android client have persistent random IDs, pairing credentials, phrase confirmation, approval, scoped read/send permissions, and host-side revocation. The Android identity and client are not device-validated.
- The host chooses one receive root. Remote access is token and approval gated; host folder browsing and root changes are local-dashboard only.
- Browser and Android sender paths use durable chunk sessions, per-chunk SHA-256 checks, server whole-file hashes, atomic publication, collision choices, resume on browser same-file reselect, cancellation, and seven-day abandoned-session cleanup.
- The Android app handles Sharesheet single/multiple content URIs, the system document picker, and downloads to Android document providers without app staging copies.
- The host announces itself over local UDP broadcast; the Android app listens and verifies the service handshake. A local dashboard QR opens the browser pairing flow; the Android app still uses a manually entered code. TLS and persistent background transfers remain open.
- The dashboard includes device controls, connection addresses, free-space diagnostics, transfer state/progress/history filters, cancellation, browser drop/paste, and file browsing. Full accessibility and device-width review remains open.
- Neither the Android app nor the frozen Windows package has been built and validated on target hardware. Real hotspot, restart/resume, large-file, and throughput measurements remain release gates.

## Guiding principles

1. **Local-first:** file contents stay on the local network and are never routed through a cloud relay.
2. **Trust is explicit:** names and IP addresses are for display; pairing credentials establish identity.
3. **Least privilege:** devices only receive access to approved roots and actions.
4. **Transfer state is durable:** progress, cancellation, restart recovery, and errors are first-class data.
5. **Source stays in place:** send from a share intent, document URI, picker handle, drag/drop, or browser picker without moving the original.
6. **Honest interface:** show source, sender, receiver/host, destination, transport, current phase, progress, and outcome.
7. **One implementation:** one backend, one frontend source tree, and documented API contracts.
8. **UI standards:** solid dark surfaces only, no gradients, no emoji, inline SVG icon system, blue active actions, emerald success, amber waiting/warning, and rose failures.

## Target architecture

```text
Android native app ── share intent / picker ──┐
                                              │ local transfer protocol
Browser dashboard ── HTTPS/local API ─────────┼── Windows host service
                                              │      ├── pairing and device registry
Other native peers ───────────────────────────┘      ├── transfer manager and durable queue
                                                     ├── scoped storage roots
                                                     └── discovery / QR fallback
```

### Components

- **Host service:** owns pairing, authorization, transfer sessions, disk writes, device status, and local discovery. Start it without elevation by default. Request elevated permissions only for a clearly explained operation that requires them.
- **Web dashboard:** host setup, connected devices, approval, transfer queue/history, destination roots, and browser fallback. Keep network APIs separate from presentation logic.
- **Android client:** Android share target and document picker, paired-device selection, send/receive queue, notifications, and access to content URIs through Android’s permission model.
- **Transport:** first use TCP over the same Wi-Fi or laptop hotspot. Add LAN discovery separately from transfer transport. Consider Wi-Fi Direct only after the shared hotspot path is reliable. Bluetooth is for pairing or small handshakes, not the large-file path.
- **Local persistence:** SQLite for devices, roots, transfer sessions, chunk checkpoints, and history. Atomic config updates for service settings. Avoid rewriting the whole JSON state file on every heartbeat.

## Detailed execution phases

## Execution record

- **Phase 0:** working defaults below are recorded and guide implementation.
- **Phase 1:** implementation foundation is in place. Both launch paths use one aiohttp server; duplicated legacy handlers and assets are removed. The backend has SQLite state with legacy JSON import, persistent receive root, local-only host controls, pairing-code exchange with per-device token hashes, approval-gated remote file access, per-device read/write scopes, canonical path containment, atomic no-overwrite uploads, and standard-user startup without automatic Windows network changes.
- **Phase 1 remaining:** validate on real Windows/hotspot/browser combinations and assess trusted TLS for local use. Pairing credentials currently travel over local HTTP, so use a trusted private hotspot. Phase 1 will be called complete after those checks are possible.
- **Phase 2:** browser and native device identity, session-code pairing, phrase verification, scoped access, rename, trust, revoke, and forget are implemented. The local dashboard QR opens the browser pairing flow. Native-app QR scan/prefill, expiring one-time QR credentials, per-device roots, and real-client revocation validation remain open.
- **Phase 2 remaining:** device identity and verification work for browser profiles and the Android app; the host can generate a local QR URL for browser pairing. Native app QR scanning/prefill, richer per-device root management, and real-client revocation validation remain open.
- **Phase 3:** transfer sessions support skip/rename/replace/cancel collision choices, two concurrent sessions maximum, durable chunk offsets, resume on same-file reselect, retry after checksum failure, cancellation, per-chunk SHA-256 re-verification, full-file hash recording, seven-day abandoned-job cleanup, and history for completed/failed sends and receives. Real interruption/restart and large-file validation remains outstanding.
- **Phase 4:** host address candidates include adapter name, IPv4 address, netmask, and broadcast address when `psutil` can read them. The connection panel copies candidate URLs and generates a local QR for browser pairing; the host broadcasts its actual selected port; Android listens and verifies the protocol handshake before offering an address. Real hotspot/firewall validation remains open.
- **Phase 5:** section navigation, active transfer progress/history filters, cancellation, collision prompts, route summary, live announcements, local free-space status, and host download history are present. Upload preflight rejects insufficient disk space. Full screen-reader, keyboard, phone-width and accessibility review remains open.
- **Phase 6:** the Android project registers as a Sharesheet target, offers the system document picker, pairs and verifies the phrase, handles destination collisions, browses the host's approved share, and streams single/multiple `content://` sources or host downloads directly between providers without staging copies. Foreground notifications, provider resume, unknown-size provider handling, partial-download cleanup, and device validation remain open.
- **Phase 7:** a real-network upload benchmark CLI reports elapsed time, throughput, and client/server SHA-256 in JSON. Benchmarks have not been run; tuning and multi-device/load measurements remain open.
- **Phase 8:** a Windows PyInstaller build script, stable frozen-app data directory with one-time sidecar DB migration, local storage/connection diagnostics, and release checklist are added. Packaging, firewall, migration, clean install, upgrade, rollback, and uninstall still require Windows validation.

## Phase 0 decisions and working defaults

These defaults let implementation proceed without blocking on product questions. They can be changed before the first native release:

- **Initial platforms:** Windows laptop host and Android client; browser UI is a fallback and host manager.
- **Initial topology:** phone and laptop connect to the same laptop hotspot. Internet is optional and must not be required. QR/manual address is the fallback if local discovery is unavailable.
- **Initial direction:** Android-to-laptop send and approved laptop-share-to-Android download work over the host service. Direct device-to-device peer routing is a later addition.
- **Peer capacity:** design for eight known devices and two concurrent transfers initially; make both configurable after benchmarks.
- **File size:** target files up to 100 GB, matching the current streaming goal, subject to filesystem free space and Android provider capabilities.
- **Receive location:** one explicitly selected host receive root. Do not grant arbitrary-drive browsing to remote peers.
- **Trust:** new devices require host approval. “Trust” is an explicit persistent choice; temporary approval expires after 15 minutes.
- **Collisions:** ask before replacing. Never silently overwrite an existing file.
- **Folder behavior:** stream a manifest and files; create ZIP only when the user chooses archive/download.
- **User-visible route:** always state source device, receiver/host, destination, transport, progress, and final outcome.
- **UI:** keep the user's zero-gradient, zero-emoji, inline-SVG and semantic status-color rules.

### Phase 0 — Define behavior and acceptance criteria

**Work**

- Confirm initial platform scope: Windows host plus Android client; browsers as fallback.
- Define maximum expected peer count, concurrent transfers, file sizes, and whether receiving on the phone is required in the first release.
- Define default destination roots, overwrite behavior, trust duration, and whether every incoming transfer needs approval.
- Define hotspot assumptions and a manual QR/code route when multicast discovery is blocked.
- Establish the UI language for device states and transfer states.

**Acceptance**

- A user can explain whether the current direction is phone-to-laptop or laptop-to-phone before starting a transfer.
- Offline operation is verified with mobile data/internet disabled.

### Phase 1 — Consolidate and secure the current foundation

**Work**

- Retire the obsolete `app/` server implementation or make it a thin compatibility launcher. Keep a single canonical UI and backend; remove duplicated assets after confirming there are no supported launch paths that depend on them.
- Replace ad hoc global mutable state with service objects and a SQLite data layer, keeping aiohttp handlers thin.
- Replace prefix-based path checks with canonical path containment checks that handle Windows case folding, drive roots, and symlinks.
- Restrict host browsing to explicit share roots. Add an allowlist of roots and read/write capabilities per paired device. Do not expose arbitrary drives by default.
- Require a pairing token for all mutating endpoints. Remove legacy upload paths that silently bypass approval when device headers are absent.
- Store tokens hashed at rest, support revocation, validate request size/path/name, and prevent filename/path header traversal.
- Stage incoming writes to unique `.partial` files; flush and atomically rename only after success. Preserve an existing file on failed/aborted upload.
- Replace broad administrator startup/elevation with least-privilege startup; request narrowly scoped firewall setup only when the user chooses network sharing.
- Add structured logs with transfer/device IDs and redaction for sensitive paths where appropriate.

**Acceptance**

- Unpaired clients cannot list private roots, upload, delete, or change share roots.
- Traversal paths and symlink escapes are rejected.
- A failed write never replaces a completed destination file.
- Exactly one server/UI implementation is documented as supported.

### Phase 2 — Device identity, pairing, and manageability

**Work**

- Give the host a stable identity and each installed client a cryptographically random identity plus secret credential.
- Pair with an expiring QR code or short code. Show the same short verification phrase on both devices and require explicit confirmation.
- Represent device state as `discovered`, `pairing`, `pending_approval`, `paired`, `online`, `offline`, `revoked`.
- Add device details: user label, platform/model where available, network address, last seen, trust status, permitted direction, allowed roots, and last transfer.
- Add actions: rename, approve once, trust, revoke, forget, restrict send/receive, and clear credentials.
- Ensure a device reappearing after an ID claim cannot inherit another device’s trust.

**Acceptance**

- A host can distinguish two identical phone models by verified label and pairing phrase.
- Revocation blocks the old device credential immediately.
- Approval duration and trust status are visible and auditable.

### Phase 3 — Robust transfer engine

**Work**

- Define a versioned transfer protocol with a create-session request, manifest, chunk upload/download, status, cancel, resume, and completion endpoints.
- Persist sessions and chunk checkpoints. Use bounded buffers, configurable chunk size, and per-peer/global concurrency limits.
- Calculate a cryptographic checksum while streaming; verify before marking complete.
- Resume from acknowledged offsets after Wi-Fi interruption or host restart. Keep partial files under managed temporary names and expire abandoned sessions according to a clear policy.
- Add collision modes: ask, rename, skip, replace. Never silently overwrite.
- Add cancellation and retry with clear state transitions: `queued`, `awaiting_approval`, `connecting`, `transferring`, `verifying`, `completed`, `failed`, `cancelled`, `interrupted`, `paused`.
- Record sender, receiver, source display name/URI type, destination root and relative path, transport, byte counts, rate samples, timestamps, checksum result, and actionable failure reason.
- Stream folder manifests and file contents individually; make ZIP creation an explicit archive/download operation rather than a prerequisite for folder transfer.

**Acceptance**

- Disconnecting Wi-Fi mid-transfer can resume without retransmitting completed chunks.
- A checksum mismatch is detected and the item is not marked complete.
- Cancel, retry, collision choices, and service restart behave predictably.

### Phase 4 — Local discovery and hotspot connection experience

**Work**

- Detect active adapters and show the laptop hotspot/Wi-Fi address candidates rather than guessing one IP.
- Advertise the host on the local network using a supported service-discovery protocol where available; support QR/code connection using an explicit address and one-time pairing secret.
- Report discovery permission or multicast limitations and explain the manual path.
- Probe reachability and service version before showing a peer as ready.
- Display connection type, signal/reachability status where available, and measured throughput after a small safe probe.
- Add reconnect behavior and remove stale discovered entries after a documented timeout.

**Acceptance**

- Android finds the laptop on the same hotspot without internet, or connects with the QR fallback when multicast is unavailable.
- A device is not shown as transfer-ready until a protocol handshake succeeds.

### Phase 5 — Frontend information architecture and interaction design

**Navigation**

- **Overview:** local network state, host address/QR, current receive destination, and a compact active queue.
- **Devices:** nearby/paired/offline sections, identity and trust controls, permissions, and last activity.
- **Transfers:** active queue, queued jobs, history, filters, per-transfer detail, pause/resume/cancel/retry.
- **Storage:** explicit receive roots, capacity, destination selection, collision defaults, and open-location actions.
- **Settings:** device name, hotspot guidance, discovery mode, security defaults, and diagnostics.

**Interaction requirements**

- Before sending, show a confirmation summary: source device, selected receiver, file count/size, destination path, collision policy, network route, and whether approval is needed.
- During sending, show one row per file with phase, transferred/total bytes, percent, current and average speed, elapsed time, estimated remaining time when reliable, and pause/cancel controls.
- After completion, show a stable result with destination and actions to open, copy location, or send again. Keep failures visible until dismissed or retried.
- Explain permission prompts in context. Never imply a browser-only picker can access arbitrary apps or register a system share target.
- Use explicit states for no devices found, hotspot disconnected, awaiting approval, reconnecting, unsupported URI, insufficient space, name collision, verification failure, and host unavailable.
- Keep destructive operations in a confirmation dialog with exact item count and names; provide undo for reversible moves/deletes if the storage model supports it.
- Keep keyboard focus visible, provide accessible labels and live regions, and ensure touch targets work on phones.
- Preserve the agreed UI constraints: zero gradients, zero emoji, consistent inline SVG icons, solid surfaces, blue active state, emerald success, amber attention, rose error.

**Acceptance**

- At every stage, the user can answer: who is sending, to whom, from where, to where, what state it is in, and what action is available next.
- State changes are announced to assistive technology and are understandable without color alone.

### Phase 6 — Android native share and receive experience

**Work**

- Create an Android app with Android Sharesheet intent filters for single and multiple files and supported content types.
- Read shared `content://` URIs under granted permissions and stream them directly to the paired receiver without copying them into an app staging folder.
- Show paired devices, availability, receive-root choice if applicable, transfer confirmation, and queue progress in the share flow.
- Use Android’s system document picker for files that are not shared through another app. Preserve persisted URI permissions only when required and disclose that behavior.
- Add foreground transfer service/notification for long sends, retry after network restoration, and Android receive support using scoped storage/document-provider APIs.
- Handle providers that cannot seek: either spool only when necessary with clear disk-space checks, or report that the source cannot resume and offer restart.

**Acceptance**

- From a camera/gallery/file app, choose Share → SuperShare → a paired laptop; no manual file staging is required.
- The original file remains at its original URI/location.
- Large transfers continue with a visible OS notification when the app is backgrounded.

### Phase 7 — Performance and reliability

**Work**

- Benchmark laptop hotspot, home Wi-Fi, and representative Android devices with small files, many files, and multi-gigabyte files.
- Measure throughput, CPU, memory, battery, time to first byte, retransmission/resume time, and UI responsiveness.
- Tune chunk size and parallelism from measurements; keep bounded memory and avoid overloading phone storage/CPU.
- Use streaming hash calculation and optional fast integrity modes only if the threat/reliability model permits.
- Add disk-space preflight, low-space warnings, thermal/battery handling where available, and safe cleanup for stale partials.
- Consider a more efficient transport only if measurements justify it; TCP over Wi-Fi remains the baseline.

**Acceptance**

- Publish benchmark conditions and measured throughput for supported configurations.
- Memory use remains bounded for large files and many-file batches.

### Phase 8 — Packaging, diagnostics, and release readiness

**Work**

- Package the Windows host with a stable data directory, versioned config migration, clear startup/shutdown, and update/rollback strategy.
- Provide firewall setup/cleanup controls with least privilege and a visible explanation of the local network exposure.
- Add a diagnostics view that checks host IP, hotspot reachability, port binding, firewall state, pairing state, free space, and recent failures without exposing file contents.
- Document setup without internet, the QR fallback, where received files go, trust/revoke behavior, and platform limits.
- Export a redacted diagnostic bundle only with explicit user action.

**Acceptance**

- A new user can install, pair, send, receive, recover an interrupted transfer, revoke a device, and uninstall without manually editing files or firewall settings.

## Proposed first release scope

1. Consolidate to one aiohttp server and one canonical UI.
2. Secure device pairing and scoped receive roots before expanding LAN access.
3. Implement resumable, verifiable phone-to-laptop transfers and a proper active transfer queue.
4. Add Android share-sheet sending from content URIs.
5. Add automatic local discovery with QR/manual fallback.
6. Keep the browser dashboard as a host manager and fallback client.

Defer peer-to-peer Wi-Fi Direct, Bluetooth file transfer, multi-hop routing, cloud relay, and broad arbitrary-drive sharing until the core single-hotspot flow is secure and measured.

## Suggested module layout

```text
backend/
  api/                 # HTTP/WebSocket handlers and request validation
  services/            # pairing, discovery, transfer orchestration
  storage/             # SQLite repository, roots, atomic file operations
  protocol/            # versioned transfer message and manifest types
  security/            # credentials, permissions, path policy
frontend/
  src/                 # one dashboard implementation and inline icon set
android/               # native share target and transfer client
docs/                  # protocol, threat model, setup, decisions
```

## Cross-cutting verification strategy

- Unit checks for path containment, permissions, protocol validation, transfer state transitions, persistence migration, and collision policy.
- Integration checks for pairing, approval expiry, revoke, upload/download, checksum mismatch, resume, cancel, server restart, and host folder changes.
- Network checks with no internet, hotspot client isolation enabled/disabled, IP changes, and interrupted Wi-Fi.
- Android checks for single/multiple content URIs, transient URI grants, backgrounding, insufficient space, provider seek limitations, and notification actions.
- UI checks for phone and desktop widths, keyboard-only use, screen-reader announcements, accessible contrast, empty/loading/error/reconnect states, and the no-emoji/no-gradient design requirements.
- Security review before exposing any arbitrary host path or trusting persistent device credentials.

## Product decisions to record

- Does the first native release need laptop-to-phone sending as well as phone-to-laptop?
- Should paired devices auto-accept, or should the receiver approve every transfer by default?
- Which host folders may be receive roots, and should a device have separate roots per sender?
- What is the maximum file size and how long should interrupted partial transfers be retained?
- Should history store absolute paths, relative paths, or a privacy-preserving display path?
- What operating systems beyond Windows and Android are in the initial support promise?
