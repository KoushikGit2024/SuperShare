# SuperShare

SuperShare is a local-network file transfer host for a Windows laptop and connected devices. Internet access is not required for transfers between devices on the same Wi-Fi or laptop hotspot.

## Current implementation

The supported server is `run.py` with the aiohttp service in `backend/` and the dashboard in `static/`. The legacy `app.server` import delegates to that same service. Browser clients pair using the session code printed in the host terminal; the host then grants read, send, or both permissions. The host dashboard controls the shared root from the laptop itself.

The browser fallback uploads files to the laptop host. Browser uploads use durable chunk sessions with per-chunk SHA-256 checks, server-side chunk re-verification and whole-file hashing, resume from acknowledged chunks after reconnecting with the same selected file, collision choices, and cancellation. The Android project registers a Sharesheet target, streams shared content URIs to the host, and browses/downloads from the approved host share directly into a document-provider destination. Local UDP discovery and manual address fallback are available.

## Run

```powershell
python -m pip install -r requirements.txt
python run.py
```

SuperShare starts with normal user permissions. It prints a session pairing code and the available local URLs. Connect the phone and laptop to the same hotspot or Wi-Fi, open the laptop URL on the phone, choose **Pair with host**, and enter the code shown in the host terminal. Compare the three-word phrase on the phone and laptop, confirm it on the phone, then grant read, send, or both permissions in the laptop dashboard.

For encrypted local connections, start with `python run.py --https`. Verify the CA SHA-256 fingerprint printed in the host terminal. Android requires that fingerprint in the client before pairing; browsers require the local CA certificate to be trusted by the operating system/browser. Without `--https`, traffic remains HTTP and should be limited to a trusted private hotspot.

Windows firewall or hotspot isolation settings may prevent clients from reaching the server. SuperShare does not change the Windows firewall or network profile automatically. If needed, allow the server port on the private hotspot network through Windows settings.

## Shared folder

The laptop dashboard can choose the active shared root. Remote clients can access only that root and only after pairing and host approval. Uploads are published only after a complete write; an existing file is preserved and the new upload is rejected instead of silently overwriting it.

## Current limitations

- Pairing uses a session code and host approval. HTTP is the default compatibility mode and does not encrypt traffic; enable `--https` and verify the printed fingerprint on clients when transport encryption is needed.
- Browser identity is per browser profile. The Android app has its own persisted random device ID. The laptop dashboard can show a local QR URL for browser pairing; the Android app currently needs the laptop URL and terminal code entered manually.
- Android native sending requires a content provider that reports a file size. Transfers show a foreground notification and can resume an interrupted upload after reopening the same source URI. If Android removes the app process, reopen SuperShare and reselect the same source from a provider that supports persisted URI grants. Host-to-phone downloads write directly to a selected document-provider destination; download restart resume is not yet supported.
- Browser HTTPS requires trusting the local CA on the computer or phone browser. Android native HTTPS requires entering the verified CA fingerprint in the app.
- Neither the Android app nor the Windows packaged build has been built or device-validated in this environment.

See [docs/LOCAL_PROTOCOL.md](docs/LOCAL_PROTOCOL.md), [docs/ANDROID_CLIENT.md](docs/ANDROID_CLIENT.md), and [docs/RELEASE_READINESS.md](docs/RELEASE_READINESS.md) for setup and remaining release gates.
