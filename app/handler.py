import os
import json
import mimetypes
import urllib.parse
from http.server import BaseHTTPRequestHandler
import config
from app.file_manager import (
    safe_join,
    list_directory,
    list_host_folders,
    create_temp_zip,
    create_multi_selection_zip,
    delete_selected_items
)


class SuperShareRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path
        params = urllib.parse.parse_qs(parsed.query)
        rel_path = params.get("path", [""])[0]

        try:
            if route == "/":
                self._serve_template("index.html")
            elif route.startswith("/static/"):
                self._serve_static(route[len("/static/"):])
            elif route == "/api/list":
                self._handle_list(rel_path)
            elif route == "/api/host-folders":
                target_dir = params.get("dir", [config.SHARE_DIR])[0]
                self._send_json(list_host_folders(target_dir))
            elif route == "/api/pick-host-gui":
                self._handle_pick_host_gui()
            elif route == "/api/download":
                self._handle_download(rel_path)
            elif route == "/api/zip":
                self._handle_zip(rel_path)
            elif route == "/api/zip-selected":
                items_json = params.get("items", ["[]"])[0]
                self._handle_zip_selected(json.loads(urllib.parse.unquote(items_json)))
            else:
                self.send_error(404)
        except Exception as e:
            self._send_json({"status": "error", "message": str(e)}, status=500)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path == "/api/upload":
                self._handle_upload()
            elif parsed.path == "/api/mkdir":
                self._handle_mkdir()
            elif parsed.path == "/api/delete-selected":
                self._handle_delete_selected()
            elif parsed.path == "/api/set-share-dir":
                self._handle_set_share_dir()
            else:
                self.send_error(404)
        except Exception as e:
            self._send_json({"status": "error", "message": str(e)}, status=500)

    def _serve_template(self, filename: str):
        filepath = os.path.join(config.TEMPLATE_DIR, filename)
        with open(filepath, "rb") as f:
            content = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(content)

    def _serve_static(self, rel_path: str):
        filepath = safe_join(config.STATIC_DIR, rel_path)
        mime_type, _ = mimetypes.guess_type(filepath)
        with open(filepath, "rb") as f:
            content = f.read()
        self.send_response(200)
        self.send_header("Content-Type", mime_type or "application/octet-stream")
        self.end_headers()
        self.wfile.write(content)

    def _handle_list(self, rel_path: str):
        items = list_directory(config.SHARE_DIR, rel_path)
        self._send_json({
            "share_root": config.SHARE_DIR,
            "current_path": rel_path,
            "items": items
        })

    def _handle_pick_host_gui(self):
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            selected = filedialog.askdirectory(
                initialdir=config.SHARE_DIR,
                title="SuperShare - Select Folder on Host PC"
            )
            root.destroy()
            if selected and os.path.isdir(selected):
                config.SHARE_DIR = os.path.abspath(selected)
                print(f"[FOLDER CHANGED] Now sharing: {config.SHARE_DIR}")
            self._send_json({"status": "ok", "share_root": config.SHARE_DIR})
        except Exception as e:
            self._send_json({"status": "error", "message": str(e)}, status=400)

    def _handle_download(self, rel_path: str):
        target = safe_join(config.SHARE_DIR, rel_path)
        file_size = os.path.getsize(target)
        filename = os.path.basename(target)
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition", f'attachment; filename="{urllib.parse.quote(filename)}"')
        self.send_header("Content-Length", str(file_size))
        self.end_headers()
        with open(target, "rb") as f:
            while chunk := f.read(config.CHUNK_SIZE):
                self.wfile.write(chunk)

    def _handle_zip(self, rel_path: str):
        tmp_zip, zip_filename = create_temp_zip(config.SHARE_DIR, rel_path)
        self._stream_and_cleanup(tmp_zip, zip_filename)

    def _handle_zip_selected(self, rel_paths: list):
        tmp_zip, zip_filename = create_multi_selection_zip(config.SHARE_DIR, rel_paths)
        self._stream_and_cleanup(tmp_zip, zip_filename)

    def _stream_and_cleanup(self, tmp_zip: str, zip_filename: str):
        try:
            size = os.path.getsize(tmp_zip)
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Disposition", f'attachment; filename="{urllib.parse.quote(zip_filename)}"')
            self.send_header("Content-Length", str(size))
            self.end_headers()
            with open(tmp_zip, "rb") as f:
                while chunk := f.read(config.CHUNK_SIZE):
                    self.wfile.write(chunk)
        finally:
            if os.path.exists(tmp_zip):
                os.remove(tmp_zip)

    def _handle_upload(self):
        rel_path = urllib.parse.unquote(self.headers.get("X-File-Path", "file.bin"))
        target = safe_join(config.SHARE_DIR, rel_path)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        length = int(self.headers.get("Content-Length", 0))
        remaining = length
        with open(target, "wb") as f:
            while remaining > 0:
                chunk = self.rfile.read(min(config.CHUNK_SIZE, remaining))
                if not chunk:
                    break
                f.write(chunk)
                remaining -= len(chunk)
        self._send_json({"status": "ok"})

    def _handle_mkdir(self):
        body = self._read_json()
        target = safe_join(config.SHARE_DIR, body.get("path", ""))
        os.makedirs(target, exist_ok=True)
        self._send_json({"status": "ok"})

    def _handle_delete_selected(self):
        body = self._read_json()
        delete_selected_items(config.SHARE_DIR, body.get("items", []))
        self._send_json({"status": "ok"})

    def _handle_set_share_dir(self):
        body = self._read_json()
        new_dir = body.get("share_dir", "").strip()
        if not os.path.isdir(new_dir):
            self._send_json({"status": "error", "message": "Invalid directory path"}, status=400)
            return
        config.SHARE_DIR = os.path.abspath(new_dir)
        print(f"[FOLDER CHANGED] Now sharing: {config.SHARE_DIR}")
        self._send_json({"status": "ok", "share_root": config.SHARE_DIR})

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _send_json(self, data: dict, status: int = 200):
        payload = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(payload)
