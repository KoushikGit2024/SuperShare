"""
api_routes.py — Unified API router facade for SuperShare.

Decomposed into domain-focused submodules (all <= 400-500 lines):
- routes_common: Shared constants, security helpers, and interface utilities.
- routes_devices: Device pairing, permissions, policies, and heartbeat handlers.
- routes_transfers: Streaming upload engine, verification, chunk hashing, and job lifecycle.
- routes_files: Directory navigation, explorer APIs, previews, and download streaming.
- routes_zip: ZIP archiving for folders and multi-selection downloads.
- routes_system: Network info, storage diagnostics, maintenance, and speedtest endpoints.
"""

from .routes_common import *
from .routes_common import (
    _ClientConnectionReset, DISCONNECT_ERRORS, OPEN_MODE, FSYNC_MODE, STALE_PARTIAL_SECONDS,
    _throttle_next, _CHUNK_HASHES, _ACTIVE_DOWNLOADS, _pair_attempts, _device_persisted_at,
    _HEADER_ALIASES, _EXCLUDED_ADAPTERS, _PAIRING_WORDS, _json_body, _same_target,
    _paired_device, _device_permissions, _effective_device, _connection_kind, _throttle,
    _expire_stale_jobs, _contiguous_chunks, _safe_display_text, _device_header,
    _device_header_text, _relative_to_share, _all_host_interfaces, _select_hotspot_interface,
    _IFACE_CACHE, _IFACE_TTL, _IFACE_LOCK, _host_interfaces, _host_addresses,
    _request_ip, _is_local_host_request, _require_host_dashboard, _require_share_access,
    _authorize_transfer_write, _authenticated_device,
)

from .routes_transfers import *
from .routes_transfers import (
    _public_transfers, _write_chunk, _verify_and_hash, _publish, _fail,
    _available_transfer_space, _cancel_active_transfer_jobs, _cancel_device_transfer_jobs,
    _get_transfer_job, create_transfer_handler, transfer_chunk_handler,
    transfer_status_handler, complete_transfer_handler, cancel_transfer_handler,
)

from .routes_devices import *
from .routes_devices import (
    _touch_device, _merge_duplicate_profiles, _public_devices,
    status_handler, upload_permission_handler, pair_device_handler, confirm_pairing_handler,
    devices_handler, rename_device_handler, forget_device_handler, revoke_device_handler,
    approve_device_handler, device_policy_handler, device_terminate_handler, pairing_qr_handler,
)

from .routes_files import *
from .routes_files import (
    _begin_download, _end_download, _content_disposition, _open_tk_folder_picker,
    list_files_handler, host_folders_handler, pick_host_gui_handler, set_share_dir_handler,
    mkdir_handler, delete_selected_handler, preview_file_handler, download_handler,
    download_stop_handler,
)

from .routes_zip import *
from .routes_zip import (
    iter_zip_entries, _zip_add, _requester_id, _stream_zip, _stream_and_remove_zip,
    zip_folder_handler, zip_selected_handler, zip_preflight_handler,
)

from .routes_system import *
from .routes_system import (
    _storage_cache, _scan_share, _SPEEDTEST_BLOCK,
    network_handler, diagnostics_handler, storage_info_handler, clear_history_handler,
    clear_partials_handler, reset_state_handler, speedtest_down_handler, speedtest_up_handler,
)
