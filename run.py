"""
run.py — Project root entry point for SuperShare.
Runs the aiohttp host without automatic elevation or network configuration.
"""
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
    args = parser.parse_args()

    active_port = args.port
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
    print(f"[PAIRING] Session pairing code: {PAIRING_CODE}")
    print("[PAIRING] Enter this code on each device to pair. Restart SuperShare to rotate it.")
    print()

    if sys.platform == "win32":
        print("[INFO] Running with standard user permissions; Windows network settings are not changed.")
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
        print("[PHONE] Available SuperShare addresses:")

        interface_names = {item["address"]: item["name"] for item in local_interfaces}
        for ip in local_ips:
            url = f"{scheme}://{ip}:{active_port}/"
            print(f"     {interface_names.get(ip, 'Network adapter')}: {url}")

        primary_ip = local_ips[0]
        phone_url = f"{scheme}://{primary_ip}:{active_port}/"

        print()

        if copy_to_clipboard(phone_url):
            print(f"[OK] Primary phone URL copied to clipboard: {phone_url}")
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
    print("[INFO] Dashboard will open automatically.")
    print("[INFO] Press CTRL+C to stop.")
    print()

    try:
        webbrowser.open(
            f"{scheme}://localhost:{active_port}/"
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
