import socket
import urllib.request
import os
import sys
import traceback
import platform
import json

LOG_FILE = "supershare_debug.log"

def log(msg):
    print(msg)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(msg + "\n")
    except Exception:
        pass

def run_diagnostics():
    # Clear old log
    if os.path.exists(LOG_FILE):
        os.remove(LOG_FILE)

    log("=" * 60)
    log(" 🔍 SUPERSHARE ADVANCED DIAGNOSTIC LOGGING TOOL")
    log("=" * 60)
    log(f" Python Version : {platform.python_version()}")
    log(f" OS Platform    : {platform.platform()}")
    log(f" Hostname       : {socket.gethostname()}")

    # 1. Test all IP resolutions
    try:
        all_ips = socket.gethostbyname_ex(socket.gethostname())[2]
        log(f" [OK] Resolved Local IPs: {all_ips}")
    except Exception as e:
        log(f" [ERROR] Failed to resolve hostname IPs: {e}")

    # 2. Test active routing socket
    active_ip = "127.0.0.1"
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        active_ip = s.getsockname()[0]
        s.close()
        log(f" [OK] Active Hotspot/Network IP route: {active_ip}")
    except Exception as e:
        log(f" [WARNING] Could not determine outbound UDP route (Normal if offline/hotspot only): {e}")

    # 3. Test port binding on 8080 and alternatives
    bound_port = None
    for p in [8080, 8000, 5000, 9000]:
        try:
            test_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            test_sock.bind(("0.0.0.0", p))
            test_sock.close()
            bound_port = p
            log(f" [OK] Port {p} is available and bindable.")
            break
        except Exception as e:
            log(f" [BUSY/BLOCKED] Port {p} could not be bound: {e}")

    if not bound_port:
        log(" [CRITICAL] No standard ports (8080, 8000, 5000, 9000) could be bound!")
    else:
        log(f" [INFO] Recommended URL for phone: http://{active_ip}:{bound_port}")

    log("\n" + "=" * 60)
    log(f" Diagnostic complete. Log saved to: {os.path.abspath(LOG_FILE)}")
    log(" Please copy the contents of supershare_debug.log and share it if issues persist.")
    log("=" * 60)

if __name__ == "__main__":
    run_diagnostics()
    input("\nPress Enter to close troubleshooter...")
