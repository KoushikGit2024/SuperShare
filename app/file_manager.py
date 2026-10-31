import os
import sys
import time
import string
import shutil
import urllib.parse
import zipfile


def get_system_drives() -> list:
    """Returns available drives/roots on the host PC so the user can browse any folder without copying."""
    drives = []
    if sys.platform == "win32":
        for letter in string.ascii_uppercase:
            drive_path = f"{letter}:\\"
            if os.path.exists(drive_path):
                drives.append({"name": f"Drive ({letter}:)", "path": drive_path})
    else:
        for p in ["/", os.path.expanduser("~"), "/sdcard", "/storage/emulated/0"]:
            if os.path.exists(p):
                drives.append({"name": p, "path": os.path.abspath(p)})
    return drives


def list_host_folders(dir_path: str) -> dict:
    """Lists subdirectories inside any host path so the user can pick any folder directly from the UI."""
    if not dir_path or not os.path.isdir(dir_path):
        dir_path = os.path.expanduser("~")
    abs_path = os.path.abspath(dir_path)
    parent_path = os.path.dirname(abs_path) if os.path.dirname(abs_path) != abs_path else ""

    folders = []
    try:
        for entry in sorted(os.scandir(abs_path), key=lambda e: e.name.lower()):
            if entry.is_dir():
                folders.append({
                    "name": entry.name,
                    "path": os.path.abspath(entry.path)
                })
    except PermissionError:
        pass

    return {
        "current": abs_path,
        "parent": parent_path,
        "drives": get_system_drives(),
        "folders": folders
    }


def safe_join(base_dir: str, rel_path: str) -> str:
    cleaned = urllib.parse.unquote(rel_path).replace("\\", "/").lstrip("/")
    full_path = os.path.abspath(os.path.join(base_dir, cleaned))
    base_abs = os.path.abspath(base_dir)
    if not full_path.startswith(base_abs):
        raise PermissionError("Access outside shared directory prohibited")
    return full_path


def list_directory(base_dir: str, rel_path: str) -> list:
    target = safe_join(base_dir, rel_path)
    items = []
    if not os.path.isdir(target):
        return items
    try:
        entries = list(os.scandir(target))
    except PermissionError:
        return []

    for entry in sorted(entries, key=lambda e: (not e.is_dir(), e.name.lower())):
        if entry.name.startswith(".temp_") and entry.name.endswith(".zip"):
            continue
        try:
            stat = entry.stat()
            items.append({
                "name": entry.name,
                "is_dir": entry.is_dir(),
                "size": stat.st_size if not entry.is_dir() else 0,
                "mtime": int(stat.st_mtime)
            })
        except Exception:
            continue
    return items


def create_temp_zip(base_dir: str, rel_path: str) -> tuple:
    target = safe_join(base_dir, rel_path)
    folder_name = os.path.basename(target) or "supershare_folder"
    tmp_zip_path = os.path.join(base_dir, f".temp_{int(time.time() * 1000)}.zip")
    with zipfile.ZipFile(tmp_zip_path, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
        for root, _, filenames in os.walk(target):
            for file in filenames:
                full_f = os.path.join(root, file)
                if os.path.abspath(full_f) == os.path.abspath(tmp_zip_path):
                    continue
                try:
                    zf.write(full_f, os.path.relpath(full_f, target))
                except Exception:
                    continue
    return tmp_zip_path, f"{folder_name}.zip"


def create_multi_selection_zip(base_dir: str, rel_paths: list) -> tuple:
    tmp_zip_path = os.path.join(base_dir, f".temp_selected_{int(time.time() * 1000)}.zip")
    with zipfile.ZipFile(tmp_zip_path, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
        for rel_p in rel_paths:
            target = safe_join(base_dir, rel_p)
            if not os.path.exists(target):
                continue
            base_item_name = os.path.basename(target)
            if os.path.isfile(target):
                if os.path.abspath(target) != os.path.abspath(tmp_zip_path):
                    zf.write(target, base_item_name)
            elif os.path.isdir(target):
                for root, _, filenames in os.walk(target):
                    for file in filenames:
                        full_f = os.path.join(root, file)
                        if os.path.abspath(full_f) == os.path.abspath(tmp_zip_path):
                            continue
                        try:
                            zf.write(full_f, os.path.join(base_item_name, os.path.relpath(full_f, target)))
                        except Exception:
                            continue
    return tmp_zip_path, f"supershare_selected_{len(rel_paths)}.zip"


def delete_selected_items(base_dir: str, rel_paths: list) -> int:
    count = 0
    base_abs = os.path.abspath(base_dir)
    for rel_p in rel_paths:
        target = safe_join(base_dir, rel_p)
        if os.path.abspath(target) == base_abs or not os.path.exists(target):
            continue
        try:
            if os.path.isdir(target):
                shutil.rmtree(target)
                count += 1
            elif os.path.isfile(target):
                os.remove(target)
                count += 1
        except Exception:
            continue
    return count
