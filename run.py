"""Project root entry point for SuperShare."""
import sys
import os
import socket
import subprocess
import webbrowser
import argparse
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

from aiohttp import web
from backend.server import create_app
from backend.config import HOST, PORT, STATE, PAIRING_CODE, save_persistent_state
from backend.api_routes import _host_interfaces


def get_local_ips():
    return [item["address"] for item in _host_interfaces()]


def is_port_in_use(port):
    with socket.socket(
        socket.AF_INET,
        socket.SOCK_STREAM
    ) as s:
        return s.connect_ex(
            ("127.0.0.1", port)
        ) == 0


def get_port_process(port):
    try:
        result = subprocess.run(
            ["netstat", "-ano"],
            capture_output=True,
            text=True,
            creationflags=subprocess.CREATE_NO_WINDOW
        )

        for line in result.stdout.splitlines():
            if (
                f":{port}" in line
                and "LISTENING" in line
            ):
                parts = line.split()

                if parts:
                    return parts[-1]

    except Exception:
        pass

    return None


def copy_to_clipboard(text):
    try:
        subprocess.run(
            ["clip"],
            input=text,
            text=True,
            check=True,
            creationflags=subprocess.CREATE_NO_WINDOW
        )

        return True

    except Exception:
        return False


def configure_hotspot_firewall_rule(port: int) -> int:
    """Set the active network Private and allow local-subnet TCP traffic."""
    if sys.platform != "win32":
        print("[ERROR] Windows Firewall setup is supported on Windows only.")
        return 1

    try:
        import ctypes
        is_admin = bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        is_admin = False

    if not is_admin:
        print("[ERROR] Firewall setup helper was not started with Administrator rights.")
        return 1

    rule_name = f"SuperShare local TCP {port} (Private profile)"
    old_rule_name = f"SuperShare local TCP {port} (Public profile)"
    old_any_rule_name = f"SuperShare local TCP {port} (Local subnet)"
    command = (
        "$ErrorActionPreference = 'Stop'; "
        "$active = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address } | Select-Object -First 1; "
        "if ($active) { "
        "$profile = Get-NetConnectionProfile -InterfaceIndex $active.InterfaceIndex -ErrorAction SilentlyContinue; "
        "if ($profile -and $profile.NetworkCategory -ne 'Private') { "
        "Set-NetConnectionProfile -InterfaceIndex $active.InterfaceIndex -NetworkCategory Private } }; "
        "$hotspotProfiles = Get-NetConnectionProfile | Where-Object { $_.InterfaceAlias -like 'Local Area Connection*' }; "
        "foreach ($profile in $hotspotProfiles) { if ($profile.NetworkCategory -ne 'Private') { "
        "Set-NetConnectionProfile -InterfaceIndex $profile.InterfaceIndex -NetworkCategory Private } }; "
        f"Get-NetFirewallRule -DisplayName '{old_rule_name}' -ErrorAction SilentlyContinue "
        "| Remove-NetFirewallRule; "
        f"Get-NetFirewallRule -DisplayName '{old_any_rule_name}' -ErrorAction SilentlyContinue "
        "| Remove-NetFirewallRule; "
        f"Get-NetFirewallRule -DisplayName '{rule_name}' -ErrorAction SilentlyContinue "
        "| Remove-NetFirewallRule; "
        "Get-NetFirewallRule | Where-Object { $_.DisplayName -eq 'python.exe' -and $_.Action -eq 'Block' } | Set-NetFirewallRule -Action Allow; "
        f"New-NetFirewallRule -DisplayName '{rule_name}' "
        "-Direction Inbound -Action Allow -Protocol TCP "
        f"-LocalPort {port} -RemoteAddress LocalSubnet -Profile Any | Out-Null"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW,
            check=False,
        )
    except OSError as exc:
        print(f"[ERROR] Could not start PowerShell: {exc}")
        return 1

    if result.returncode:
        details = (result.stderr or result.stdout).strip()
        print(f"[ERROR] Windows Firewall rule was not created: {details or 'PowerShell failed.'}")
        return 1

    print("[OK] Active network and Windows hotspot profiles are Private.")
    print(f"[OK] Windows Firewall allows local-subnet TCP {port} on the Private profile.")
    print("[INFO] No router port forwarding was added.")
    return 0


def local_subnet_firewall_rule_exists(port: int) -> bool:
    rule_name = f"SuperShare local TCP {port} (Private profile)"
    check = (
        f"$r = Get-NetFirewallRule -DisplayName '{rule_name}' -ErrorAction SilentlyContinue; "
        "foreach ($x in $r) { "
        "$p = $x | Get-NetFirewallPortFilter; "
        "$a = $x | Get-NetFirewallAddressFilter; "
        "$active = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address } | Select-Object -First 1; "
        "$profiles = @(); if ($active) { $profiles += Get-NetConnectionProfile -InterfaceIndex $active.InterfaceIndex -ErrorAction SilentlyContinue }; "
        "$profiles += Get-NetConnectionProfile | Where-Object { $_.InterfaceAlias -like 'Local Area Connection*' }; "
        f"if ($x.Enabled -eq 'True' -and $x.Direction -eq 'Inbound' -and $x.Action -eq 'Allow' -and "
        "$x.Profile.ToString() -eq 'Private' -and $profiles.Count -gt 0 -and "
        "@($profiles | Where-Object { $_.NetworkCategory -ne 'Private' }).Count -eq 0 -and "
        f"[string]$p.Protocol -eq 'TCP' -and [string]$p.LocalPort -eq '{port}' -and "
        "[string]$a.RemoteAddress -eq 'LocalSubnet') { exit 0 } }; exit 1"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", check],
            capture_output=True,
            creationflags=subprocess.CREATE_NO_WINDOW,
            check=False,
        )
        return result.returncode == 0
    except OSError:
        return False


def ensure_hotspot_firewall_rule(port: int) -> bool:
    """Apply the Private-profile network setup through an elevated helper when needed."""
    try:
        import ctypes
        from ctypes import wintypes
        is_admin = bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        print("[WARNING] Could not check Windows administrator status; firewall rule was not changed.")
        return False

    if False and local_subnet_firewall_rule_exists(port):
        print(f"[OK] Network profile and local-subnet TCP {port} firewall rule are already configured.")
        return True

    if is_admin:
        return configure_hotspot_firewall_rule(port) == 0

    class ShellExecuteInfo(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("fMask", ctypes.c_ulong),
            ("hwnd", wintypes.HWND),
            ("lpVerb", wintypes.LPCWSTR),
            ("lpFile", wintypes.LPCWSTR),
            ("lpParameters", wintypes.LPCWSTR),
            ("lpDirectory", wintypes.LPCWSTR),
            ("nShow", ctypes.c_int),
            ("hInstApp", wintypes.HINSTANCE),
            ("lpIDList", ctypes.c_void_p),
            ("lpClass", wintypes.LPCWSTR),
            ("hkeyClass", wintypes.HKEY),
            ("dwHotKey", wintypes.DWORD),
            ("hIconOrMonitor", wintypes.HANDLE),
            ("hProcess", wintypes.HANDLE),
        ]

    helper_args = f'"{Path(__file__).resolve()}" --_install-firewall-helper --port {port}'
    info = ShellExecuteInfo()
    info.cbSize = ctypes.sizeof(info)
    info.fMask = 0x00000040  # SEE_MASK_NOCLOSEPROCESS
    info.lpVerb = "runas"
    info.lpFile = sys.executable
    info.lpParameters = helper_args
    info.lpDirectory = str(PROJECT_ROOT)
    info.nShow = 0  # The setup helper runs without opening a second console.

    shell32 = ctypes.windll.shell32
    shell32.ShellExecuteExW.argtypes = [ctypes.POINTER(ShellExecuteInfo)]
    shell32.ShellExecuteExW.restype = wintypes.BOOL
    if not shell32.ShellExecuteExW(ctypes.byref(info)):
        error = ctypes.windll.kernel32.GetLastError()
        if error == 1223:
            print("[WARNING] Windows Firewall setup was cancelled. Phone access may be blocked on Public networks.")
        else:
            print(f"[WARNING] Could not request firewall setup (Windows error {error}).")
        return False

    print("[INFO] Waiting for approval to set the network profile to Private and allow local-subnet TCP...")
    kernel32 = ctypes.windll.kernel32
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.WaitForSingleObject(info.hProcess, 0xFFFFFFFF)
    exit_code = wintypes.DWORD()
    succeeded = bool(kernel32.GetExitCodeProcess(info.hProcess, ctypes.byref(exit_code))) and exit_code.value == 0
    kernel32.CloseHandle(info.hProcess)
    if succeeded:
        print(f"[OK] Private network profile and local-subnet TCP {port} firewall rule are configured.")
    else:
        print("[WARNING] Windows network/firewall setup failed. Phone access may be blocked.")
    return succeeded


def print_header():
    print()
    print("=" * 68)
    print("                         SUPERSHARE")
    print("=" * 68)
    print()


def pick_folder_gui(initial_dir: str) -> str:
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        selected = filedialog.askdirectory(
            initialdir=initial_dir,
            title="SuperShare - Select Any Folder or Drive to Share"
        )
        root.destroy()
        return selected if selected else initial_dir
    except Exception:
        return initial_dir


def main():
    parser = argparse.ArgumentParser(description="SuperShare — Offline File & Folder Hub")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--dir", type=str, default=None)
    parser.add_argument("--gui", action="store_true")
    parser.add_argument("--https", action="store_true", help="Enable local TLS; trust the printed local CA in browser clients")
    parser.add_argument("--_install-firewall-helper", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()

    active_port = args.port
    if not 1 <= active_port <= 65535:
        parser.error("--port must be between 1 and 65535")
    if args._install_firewall_helper:
        return configure_hotspot_firewall_rule(active_port)

    tls_context = None
    tls_info = None
    if args.https:
        from backend.tls_config import create_tls_context
        try:
            tls_context, tls_info = create_tls_context()
        except Exception as exc:
            print(f"[ERROR] Could not create local TLS certificates: {exc}")
            print("[INFO] Install project requirements and retry, or use HTTP only on a trusted private hotspot.")
            return 1

    print_header()
    # Open local network sharing enabled
    print()

    if sys.platform == "win32":
        print("[INFO] Running the file-sharing server with standard user permissions.")
        ensure_hotspot_firewall_rule(active_port)
    if tls_info:
        print("[TLS] HTTPS enabled. Verify this CA SHA-256 fingerprint on each client:")
        print(f"      {tls_info['ca_fingerprint']}")
        print(f"[TLS] Local CA certificate: {tls_info['ca_cert_path']}")

    scheme = "https" if tls_context else "http"

    if args.dir and os.path.isdir(args.dir):
        STATE["share_dir"] = os.path.abspath(args.dir)
    elif args.gui:
        STATE["share_dir"] = os.path.abspath(pick_folder_gui(STATE["share_dir"]))
    save_persistent_state()

    print("[PORT] Checking server port...")

    if is_port_in_use(active_port):
        pid = get_port_process(active_port)

        print()
        print(f"[ERROR] Port {active_port} is already in use.")

        if pid:
            print(f"[INFO] Process ID: {pid}")

        print()
        print("To identify the process:")
        print(f"  netstat -ano | findstr :{active_port}")

        if pid:
            print()
            print("If it is an old process, stop it with:")
            print(f"  taskkill /PID {pid} /F")

        print()
        return 1

    print(f"[OK] Port {active_port} is available.")
    print()

    local_interfaces = _host_interfaces()
    local_ips = [item["address"] for item in local_interfaces]

    print(f"[SERVER] Shared Folder : {STATE['share_dir']}")
    print(f"[SERVER] Host          : {HOST}")
    print(f"[SERVER] Port          : {active_port}")
    print()

    print("[PC] Dashboard:")
    print(f"     {scheme}://localhost:{active_port}/")

    print()

    phone_url = None

    if local_ips:
        print("[PHONE] Share this address with devices on the same hotspot or Wi-Fi:")

        interface_names = {item["address"]: item["name"] for item in local_interfaces}
        for ip in local_ips:
            url = f"{scheme}://{ip}/" if active_port == 80 else f"{scheme}://{ip}:{active_port}/"
            print(f"     {interface_names.get(ip, 'Network adapter')}: {url}")

        primary_ip = local_ips[0]
        phone_url = f"{scheme}://{primary_ip}/" if active_port == 80 else f"{scheme}://{primary_ip}:{active_port}/"

        print()

        if copy_to_clipboard(phone_url):
            print(f"[OK] Connection address copied to clipboard: {phone_url}")
        else:
            print("[INFO] Could not copy URL to clipboard.")

    else:
        print("[WARNING] Could not detect a LAN IP.")
        print("[INFO] Phone connection may require manual configuration.")
        print("[INFO] If Windows Firewall blocks access, allow SuperShare on the private hotspot network.")

    print()
    print("=" * 68)
    print("                    STARTING SERVER")
    print("=" * 68)
    print()
    print(f"[INFO] Listening for local TCP connections on {HOST}:{active_port}.")
    print("[INFO] This is a local-network service, not an internet-public server.")
    print("[INFO] Dashboard will open automatically.")
    print("[INFO] Press CTRL+C to stop.")
    print()

    try:
        webbrowser.open(
            f"{scheme}://localhost/" if active_port == 80 else f"{scheme}://localhost:{active_port}/"
        )

        web.run_app(
            create_app(port=active_port, tls_info=tls_info),
            host=HOST,
            port=active_port,
            ssl_context=tls_context,
            print=None
        )

    except KeyboardInterrupt:
        print()
        print("[STOP] SuperShare stopped.")
        print()

    except OSError as e:
        print()
        print(f"[ERROR] Could not start server: {e}")
        print()

        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
