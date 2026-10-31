  # 📖 SuperShare Practical Run Guide

## 1. Start the Server
Open PowerShell or Command Prompt inside the `supershare` folder and run:
```powershell
python run.py
```
*(Or double-click `start_windows.bat`)*

When prompted by Windows User Account Control (UAC), click **Yes**. `run.py` will automatically:
1. Detect your active Wi-Fi Hotspot adapter (`InterfaceAlias`) and Laptop IPv4 address.
2. Switch the adapter network category from **Public** to **Private**.
3. Verify or create the Windows Firewall inbound rule on **TCP Port 8765**.
4. Start the `aiohttp` server on `0.0.0.0:8765`.

## 2. Open on Phone
Look at the terminal output under `[PHONE] Available SuperShare addresses:` and open that link in Chrome on your phone:
```text
http://10.x.x.x:8765/
```

## 3. Browse Any Folder or Drive Without Copying
- Tap **"🗂️ Browse Host PC Drives / Folders"** at the top of the page (works from both your phone and laptop!).
- Switch between `C:\`, `D:\`, or any subfolder on your computer and tap **"✅ Share & Open This Folder"**.
- Or click **"💻 Native PC Popup"** to pick a folder using the Windows folder dialog on your laptop.

## 4. Select & Transfer Files/Folders
- **Download Single File or Folder:** Tap **⬇️ Save** on any file, or **📦 ZIP** on any folder.
- **Multi-Select Download / Delete:** Check the boxes next to multiple files and folders, then tap **📦 Download Selected (.zip)** or **🗑️ Delete** in the floating bottom bar.
- **Upload Huge Files or Entire Folders:** Tap **📄 Select Files** or **📁 Select Folder** to stream files from your phone to the currently open PC folder with a live MB/s speed meter.
