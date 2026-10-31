# SuperShare run guide

## Start the laptop host

Install requirements and start the local host from the project directory:

```powershell
python -m pip install -r requirements.txt
python run.py
```

The terminal prints a session pairing code and local browser URLs. Keep the host process running while devices connect and transfer files. To enable optional HTTPS, run `python run.py --https`; each browser must trust the generated local CA before using the HTTPS address.

## Connect another device using its browser

1. Connect the laptop and client device to the same Wi-Fi or laptop hotspot. Internet access is not needed for local transfers.
2. On the laptop dashboard, show the QR code or copy the address for the relevant network adapter.
3. Open that address in the other device's browser.
4. Choose **Pair with host**, enter the pairing code shown in the laptop terminal, compare the verification phrase, and confirm it.
5. On the laptop dashboard, approve the browser with read access, send access, or both. Temporary approval lasts 15 minutes; trusted access persists until revoked.

The client identity belongs to that browser profile. Ordinary web pages cannot listen to UDP broadcasts, install a universal system share target, or silently read arbitrary device paths.

## Choose the host receive folder

Use **Browse host folders** or **Open PC folder picker** from the laptop dashboard to select the receive root. Remote browsers can access only the approved root and permissions. Existing files are protected by collision handling; uploads are verified before publication.

## Send and receive

- To send to the laptop, select files or a folder, drag files into the drop area, or paste copied files. The browser reads the selected originals and streams them; SuperShare does not create an extra source copy.
- If a connection drops, reopen the site in the same browser profile and select the same source file again to resume acknowledged chunks.
- To receive from the laptop, browse the shared files and download the chosen item. Browser download behavior and save-location prompts depend on browser settings.

## Network troubleshooting

On Windows, normal `python run.py` startup checks the default-route network and Windows hotspot profiles. When setup is needed, Windows asks for administrator approval to set those profiles to Private and add an inbound TCP rule for the selected port, limited to local-subnet addresses on the Private profile. The file-sharing server itself continues to run as your normal user, and no router port forwarding is configured. If setup is cancelled or a client still cannot connect, confirm both devices use the same hotspot and client isolation is disabled. UDP port `8766` is a host announcement only; browser pages cannot consume it, so QR/manual URLs are the web onboarding path.

HTTP is the default and leaves pairing credentials and file data unencrypted on the local network. Use a trusted private network or enable HTTPS and install/trust the generated local CA in each browser. Do not bypass a browser certificate warning without verifying the certificate fingerprint printed by the host.

## Known limitations

- No separate client app is required or included; clients use browsers.
- Browser access to source files requires explicit picker, drag/drop, or paste permission. Universal OS share-sheet registration and silent access to arbitrary paths are browser-restricted.
- Resume requires reselecting the same file in the same browser profile. Closing or suspending a tab may interrupt active work.
- Transfers route through the laptop host; direct device-to-device transfer is not implemented.
- The host uses one configured receive root. Per-device destinations and internet/cloud relay are out of scope.
