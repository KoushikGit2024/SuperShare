"""
config.py — Central configuration for SuperShare.
"""
from pathlib import Path
import os

BACKEND_DIR = Path(__file__).resolve().parent
BASE_DIR = BACKEND_DIR.parent
STATIC_DIR = BASE_DIR / "static"
TEMPLATE_DIR = STATIC_DIR / "templates"
SHARE_DIR = BASE_DIR / "shared_files"

os.makedirs(SHARE_DIR, exist_ok=True)

HOST = "0.0.0.0"
PORT = 8765
CHUNK_SIZE = 4 * 1024 * 1024  # 4 MB streaming chunks for huge files

# Mutable runtime state so the active shared directory can be changed on the fly
STATE = {
    "share_dir": str(SHARE_DIR.resolve())
}
