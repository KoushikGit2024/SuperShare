# SuperShare run guide

## Start the laptop host

Run from the project directory:

```powershell
python run.py
```

SuperShare runs with normal user permissions. The terminal shows the current session pairing code and local URLs. Keep the host process open while transferring.

## Connect a phone on the laptop hotspot

1. Turn on the laptop hotspot and connect the phone to it. Internet access is not required.
2. Open the laptop URL printed by SuperShare in the phone browser.
3. Choose **Pair with host** and enter the code from the laptop terminal.
4. Compare the three-word phrase shown on the phone and laptop, then confirm on the phone.
5. On the laptop dashboard, grant read, send, or both for 15 minutes, or trust the device with both permissions.

The phone can access shared files and upload only within the permissions granted. Restarting SuperShare rotates the session pairing code; already paired device credentials remain stored until forgotten or revoked.

## Choose the receive folder

Use the laptop dashboard's host-folder browser or native folder picker to set the active receive root. Remote clients can only access paths inside this selected root. A file that already exists at the destination is preserved; the incoming upload reports a conflict rather than replacing it.

## Network troubleshooting

SuperShare does not automatically change Windows network profiles or firewall rules. If the phone cannot connect, check that both devices are on the same hotspot, that hotspot client isolation is disabled, and that Windows Firewall allows the configured TCP port on the private hotspot network.

## Known limitations

The browser interface sends files to the laptop host. Native Android system-share integration, direct peer-to-peer sending, automatic discovery, resumable transfers, and cancellation are planned but not yet available. Pairing currently uses local-network HTTP, so use a trusted private network.
