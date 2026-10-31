# SuperShare

SuperShare is a local-network file transfer host for a Windows laptop and connected devices. Internet access is not required for transfers between devices on the same Wi-Fi or laptop hotspot.

## Current implementation

The supported server is `run.py` with the aiohttp service in `backend/` and the dashboard in `static/`. The legacy `app.server` import delegates to that same service. Browser clients pair using the session code printed in the host terminal; the host then grants read, send, or both permissions. The host dashboard controls the shared root from the laptop itself.

The browser fallback uploads files to the laptop host. It does not yet send to a chosen peer or register as Android's system share target. Browser uploads use durable chunk sessions with per-chunk SHA-256 checks, server-side whole-file hashing, resume from acknowledged chunks after reconnecting with the same selected file, and explicit cancellation through the transfer API. Native Android sharing and automatic discovery remain planned work.

## Run

```powershell
python run.py
```

SuperShare starts with normal user permissions. It prints a session pairing code and the available local URLs. Connect the phone and laptop to the same hotspot or Wi-Fi, open the laptop URL on the phone, choose **Pair with host**, and enter the code shown in the host terminal. Compare the three-word phrase on the phone and laptop, confirm it on the phone, then grant read, send, or both permissions in the laptop dashboard.

Windows firewall or hotspot isolation settings may prevent clients from reaching the server. SuperShare does not change the Windows firewall or network profile automatically. If needed, allow the server port on the private hotspot network through Windows settings.

## Shared folder

The laptop dashboard can choose the active shared root. Remote clients can access only that root and only after pairing and host approval. Uploads are published only after a complete write; an existing file is preserved and the new upload is rejected instead of silently overwriting it.

## Current limitations

- Pairing uses a session code and local-network HTTP; it is an initial access-control layer, not protection against a hostile network observer. Use a trusted private hotspot until local HTTPS is implemented.
- Browser identity is per browser profile. Native device identity and QR verification are planned.
- A browser can resume an interrupted upload by selecting the same file again in the same browser profile. Cancelling is currently available through the API and will get a dashboard control in the transfer-management phase.
- The full host receive flow is browser-based. Direct Android Share-menu integration requires the planned native Android app.
