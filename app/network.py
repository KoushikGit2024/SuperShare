import socket

def get_local_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip

def print_startup_banner(ip: str, port: int, share_dir: str):
    url = f"http://{ip}:{port}"
    print("=" * 68)
    print(" ⚡ SUPERSHARE v3.0 - DIRECT HOST BROWSER (ZERO INTERNET) ⚡")
    print("=" * 68)
    print(f" 📂 Shared Root  : {share_dir}")
    print(f" 🌐 Local Address : {url}")
    print(" 📱 Open this link in Chrome on your Android Hotspot connection!")
    print("=" * 68)
