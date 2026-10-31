# ⚡ SuperShare v4.0 (NER_RMCH aiohttp + Auto-Network Engine Edition)

High-speed, zero-internet file and folder sharing between your **Windows Laptop** and **Android Phone** over a local Mobile Hotspot.

Built on the exact proven architecture from **NER_RMCH**:
1. **`aiohttp` Async Web Server** with the Windows `_ProactorBasePipeTransport` connection-reset patch.
2. **Automatic Windows UAC Admin Elevation** (`ShellExecuteW` `runas`).
3. **Active Hotspot Gateway Detection** (`Get-NetIPConfiguration`) & automatic switching from `Public` to `Private` network profile (`Set-NetConnectionProfile`).
4. **Automatic Windows Firewall Rule Creation** on Port `8765` (`New-NetFirewallRule`).
5. **Direct Host PC Drive & Folder Browser** — pick any drive (`C:\`, `D:\`) or folder directly from your phone or PC without copying files into `shared_files`!

---

## 🚀 How to Run

### 1. Ensure `aiohttp` is installed (already installed if you ran NER_RMCH)
```powershell
python -m pip install aiohttp
```

### 2. Connect Laptop to Phone Hotspot
1. Turn **ON Wi-Fi Hotspot** on your Android phone (you can turn Mobile Data OFF).
2. Connect your Windows laptop to that hotspot.

### 3. Start SuperShare
```powershell
python run.py
```
*(Or double-click `start_windows.bat`)*

- Click **Yes** when Windows asks for Administrator permission.
- The script will automatically configure the `"Wi-Fi"` profile to `Private`, allow port `8765` in Windows Firewall, copy the phone URL to your clipboard, and open the dashboard.
- Open `http://<LAPTOP-IP>:8765/` on your Android phone browser!
