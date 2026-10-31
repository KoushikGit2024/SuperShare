import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SHARE_DIR = os.path.join(BASE_DIR, "shared_files")

HOST = "0.0.0.0"
PORT = 8765  # Uses 8765 just like NER_RMCH (avoids 8080/8000 conflicts)
CHUNK_SIZE = 4 * 1024 * 1024  # 4MB streaming chunks

TEMPLATE_DIR = os.path.join(BASE_DIR, "app", "templates")
STATIC_DIR = os.path.join(BASE_DIR, "app", "static")

os.makedirs(SHARE_DIR, exist_ok=True)
