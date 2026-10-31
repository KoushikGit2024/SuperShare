# SuperShare

SuperShare is a local-network file transfer host for a Windows laptop and connected devices. Internet access is not required for transfers between devices on the same Wi-Fi or laptop hotspot.

## Current implementation

The supported server is `run.py` with the aiohttp service in `backend/` and the dashboard in `static/`. The legacy `app.server` import delegates to that same service. Browser clients pair using the session code printed in the host terminal; the host then grants read, send, or both permissions. The host dashboard controls the shared root from the laptop itself.

All client interaction happens in a web browser; there is no Android or desktop client app. Browser uploads use durable chunk sessions with per-chunk SHA-256 checks, server-side chunk re-verification and whole-file hashing, resume from acknowledged chunks after reconnecting with the same file selected again, collision choices, and cancellation. Use the browser file picker, folder picker, drag-and-drop, or paste to send files directly from their existing locations; SuperShare reads the browser-provided file handles and does not create a source copy. Use the dashboard QR code or a listed local URL to open the site on another device.

## Run

```powershell
python -m pip install -r requirements.txt
python run.py
```

SuperShare starts with normal user permissions. It prints a session pairing code and the available local URLs. Connect the devices to the same hotspot or Wi-Fi, open the laptop URL in each device's browser, choose **Pair with host**, and enter the code shown in the host terminal. Compare the three-word phrase on the joining browser and laptop, confirm it, then grant read, send, or both permissions in the laptop dashboard.

For encrypted local connections, start with `python run.py --https`. Browsers require the local CA certificate to be trusted by the operating system/browser. Without `--https`, traffic remains HTTP and should be limited to a trusted private hotspot.

On Windows, normal `python run.py` startup checks the default-route network and Windows hotspot profiles. When setup is needed, Windows asks for administrator approval to set those profiles to Private and add an inbound TCP rule for the selected port, limited to local-subnet addresses on the Private profile. The file-sharing server itself continues to run as your normal user. No router port forwarding is configured. If setup is cancelled, hotspot clients may still be blocked by the firewall.

## Shared folder

The laptop dashboard can choose the active shared root. Remote clients can access only that root and only after pairing and host approval. Uploads are published only after a complete write; an existing file is preserved and the new upload is rejected instead of silently overwriting it.

## Current limitations

- Pairing uses a session code and host approval. HTTP is the default compatibility mode and does not encrypt traffic; enable `--https` and verify the printed fingerprint on clients when transport encryption is needed.
- Each browser profile is identified separately; the laptop dashboard can show a local QR URL for opening and pairing another browser.
- Browser security restrictions require the user to select or drop source files. The page can read the selected files for transfer but cannot silently access arbitrary device paths or receive an OS share-sheet action in every browser.
- Browser HTTPS requires trusting the local CA on the computer or phone browser.
- The website has not been validated across representative browsers and hotspots, and the Windows packaged host has not been device-validated in this environment.

See [docs/LOCAL_PROTOCOL.md](docs/LOCAL_PROTOCOL.md) and [docs/RELEASE_READINESS.md](docs/RELEASE_READINESS.md) for setup and remaining release gates.
