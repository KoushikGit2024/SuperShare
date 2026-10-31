"""
run.py — Project root entry point for SuperShare.
Uses the exact Windows UAC elevation, PowerShell active network detection,
Private network profile enforcement, firewall rule setup, and aiohttp runner
from NER_RMCH/run.py.
"""
import sys
import os
import socket
import subprocess
import webbrowser
import ctypes
import argparse
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

from aiohttp import web
from backend.server import create_app
from backend.config import HOST, PORT, STATE


def is_admin():
    if sys.platform != "win32":
        return True

    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def relaunch_as_admin():
    if sys.platform != "win32":
        return False

    try:
        params = subprocess.list2cmdline(sys.argv)

        result = ctypes.windll.shell32.ShellExecuteW(
            None,
            "runas",
            sys.executable,
            params,
            str(PROJECT_ROOT),
            1
        )

        return result > 32
    except Exception as e:
        print(f"[ERROR] Administrator elevation failed: {e}")
        return False


def run_powershell(command):
    try:
        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                command
            ],
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=subprocess.CREATE_NO_WINDOW
        )

        return result.returncode, result.stdout.strip(), result.stderr.strip()

    except subprocess.TimeoutExpired:
        return -1, "", "PowerShell command timed out."

    except Exception as e:
        return -1, "", str(e)


def get_active_network():
    command = """
    Get-NetIPConfiguration |
    Where-Object {
        $_.IPv4DefaultGateway -ne $null -and
        $_.IPv4Address -ne $null
    } |
    Select-Object -First 1 |
    ForEach-Object {
        [PSCustomObject]@{
            InterfaceAlias = $_.InterfaceAlias
            IPv4 = $_.IPv4Address.IPAddress
        }
    } |
    ConvertTo-Json -Compress
    """

    code, stdout, _ = run_powershell(command)

    if code != 0 or not stdout:
        return None, None

    try:
        import json

        data = json.loads(stdout)

        return (
            data.get("InterfaceAlias"),
            data.get("IPv4")
        )

    except Exception:
        return None, None


def get_network_profile(interface_alias):
    if not interface_alias:
        return None

    command = f"""
    Get-NetConnectionProfile -InterfaceAlias '{interface_alias}' |
    Select-Object -ExpandProperty NetworkCategory
    """

    code, stdout, _ = run_powershell(command)

    if code == 0:
        return stdout.strip()

    return None


def configure_network_profile(interface_alias):
    if not interface_alias:
        return False

    profile = get_network_profile(interface_alias)

    if profile == "Private":
        print("[OK] Network profile already Private.")
        return True

    if profile == "Public":
        print(f"[NETWORK] Changing '{interface_alias}' to Private...")

        command = (
            f"Set-NetConnectionProfile "
            f"-InterfaceAlias '{interface_alias}' "
            f"-NetworkCategory Private"
        )

        code, _, stderr = run_powershell(command)

        if code == 0:
            print("[OK] Network profile changed to Private.")
            return True

        print(f"[ERROR] Could not change network profile: {stderr}")
        return False

    if profile:
        print(f"[INFO] Network profile: {profile}")
        return True

    print("[WARNING] Could not determine network profile.")
    return False


def configure_firewall(port):
    rule_name = f"SuperShare TCP {port}"

    command = (
        f"Get-NetFirewallRule "
        f"-DisplayName '{rule_name}' "
        f"-ErrorAction SilentlyContinue"
    )

    code, stdout, _ = run_powershell(command)

    if code == 0 and stdout:
        print(f"[OK] Firewall rule already exists: {rule_name}")
        return True

    print(f"[FIREWALL] Creating inbound TCP rule for port {port}...")

    command = (
        f"New-NetFirewallRule "
        f"-DisplayName '{rule_name}' "
        f"-Direction Inbound "
        f"-Protocol TCP "
        f"-LocalPort {port} "
        f"-Action Allow "
        f"-Profile Private"
    )

    code, _, stderr = run_powershell(command)

    if code == 0:
        print("[OK] Firewall rule created.")
        return True

    print(f"[ERROR] Firewall configuration failed: {stderr}")
    return False


def get_local_ips():
    ips = set()

    try:
        hostname = socket.gethostname()

        for info in socket.getaddrinfo(
            hostname,
            None,
            socket.AF_INET
        ):
            ip = info[4][0]

            if not ip.startswith("127."):
                ips.add(ip)

    except Exception:
        pass

    try:
        s = socket.socket(
            socket.AF_INET,
            socket.SOCK_DGRAM
        )

        s.connect(("10.255.255.255", 1))

        ip = s.getsockname()[0]

        if not ip.startswith("127."):
            ips.add(ip)

        s.close()

    except Exception:
        pass

    return sorted(ips)


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


def print_header():
    print()
    print("=" * 68)
    print("                         SUPERSHARE")
    print("=" * 68)
    print()


def setup_windows_network(port):
    print("[SETUP] Checking Windows network configuration...")
    print()

    interface_alias, local_ip = get_active_network()

    if interface_alias:
        print(f"[NETWORK] Active adapter : {interface_alias}")

    if local_ip:
        print(f"[NETWORK] Laptop IP       : {local_ip}")

    print()

    if interface_alias:
        configure_network_profile(interface_alias)
    else:
        print("[WARNING] Could not detect active network adapter.")

    print()

    configure_firewall(port)

    print()

    return interface_alias, local_ip


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
    args = parser.parse_args()

    active_port = args.port

    print_header()

    if sys.platform == "win32" and not is_admin():
        print("[SETUP] Administrator privileges required.")
        print("[SETUP] Requesting Windows administrator access...")
        print()

        if relaunch_as_admin():
            return 0

        print("[ERROR] Could not obtain administrator privileges.")
        print("[INFO] Right-click PowerShell and select 'Run as administrator'.")
        print()
        return 1

    active_ip = None
    if sys.platform == "win32":
        print("[OK] Administrator privileges confirmed.")
        print()

        _, active_ip = setup_windows_network(active_port)

    if args.dir and os.path.isdir(args.dir):
        STATE["share_dir"] = os.path.abspath(args.dir)
    elif args.gui:
        STATE["share_dir"] = os.path.abspath(pick_folder_gui(STATE["share_dir"]))

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

    local_ips = get_local_ips()

    print(f"[SERVER] Shared Folder : {STATE['share_dir']}")
    print(f"[SERVER] Host          : {HOST}")
    print(f"[SERVER] Port          : {active_port}")
    print()

    print("[PC] Dashboard:")
    print(f"     http://localhost:{active_port}/")

    print()

    phone_url = None

    if local_ips:
        print("[PHONE] Available SuperShare addresses:")

        for ip in local_ips:
            url = f"http://{ip}:{active_port}/"
            print(f"     {url}")

        primary_ip = active_ip if active_ip else local_ips[0]
        phone_url = f"http://{primary_ip}:{active_port}/"

        print()

        if copy_to_clipboard(phone_url):
            print(f"[OK] Primary phone URL copied to clipboard: {phone_url}")
        else:
            print("[INFO] Could not copy URL to clipboard.")

    else:
        print("[WARNING] Could not detect a LAN IP.")
        print("[INFO] Phone connection may require manual configuration.")

    print()
    print("=" * 68)
    print("                    STARTING SERVER")
    print("=" * 68)
    print()
    print("[INFO] Dashboard will open automatically.")
    print("[INFO] Press CTRL+C to stop.")
    print()

    try:
        webbrowser.open(
            f"http://localhost:{active_port}/"
        )

        web.run_app(
            create_app(),
            host=HOST,
            port=active_port,
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
