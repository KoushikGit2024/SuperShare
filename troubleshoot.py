import socket
import urllib.request
import os

def check_network():
    print("=" * 60)
    print(" 🔍 SUPERSHARE NETWORK & CONNECTION TROUBLESHOOTER")
    print("=" * 60)
    
    # 1. Get Hostname & Local IPs
    hostname = socket.gethostname()
    print(f" [1] PC Hostname : {hostname}")
    
    try:
        all_ips = socket.gethostbyname_ex(hostname)[2]
        print(f" [2] All Detected IPs on this PC:")
        for ip in all_ips:
            print(f"     -> {ip}")
    except Exception as e:
        print(f"     Could not resolve hostname IPs: {e}")

    # 2. Check active routing IP
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    active_ip = "127.0.0.1"
    try:
        s.connect(("10.255.255.255", 1))
        active_ip = s.getsockname()[0]
        print(f" [3] Active Hotspot / Network IP : {active_ip}")
    except Exception as e:
        print(f"     Could not determine active route: {e}")
    finally:
    
        s.close()

    print("\n [4] COMMON REASONS WHY THE PHONE CANNOT OPEN THE LINK:")
    print("     - Mobile Data is still turned ON on your phone (Disable it!)")
    print("     - Windows Firewall is blocking inbound connections on port 8080.")
    print("     - PC and Phone are connected to different Wi-Fi networks/hotspots.")
    print("-" * 60)
    print(f" 👉 Try opening this exact link in your phone browser:")
    print(f"    http://{active_ip}:8080")
    print("=" * 60)

if __name__ == "__main__":
    check_network()
    input("\nPress Enter to exit troubleshooter...")
