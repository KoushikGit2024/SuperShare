// static/js/pages/storage_mgr.js
// Host maintenance: storage usage, Disk Space Sentinel, partial cleanup, history clearance, state reset
import { formatBytes, showNotice, confirmAction } from "../services/utils.js";
import { refreshDevices } from "./devices.js";

async function post(url, body = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.text()) || `Request failed (${res.status})`);
  return res.json();
}

export async function refreshStorageInfo() {
  try {
    const res = await fetch("/api/storage-info");
    if (!res.ok) return; // remote browsers get 403; the Storage tab is host-only
    const data = await res.json();
    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    set("metricFreeDisk", formatBytes(data.disk_free));
    set("metricTotalDisk", `of ${formatBytes(data.disk_total)} total`);
    set("metricSharedSize", formatBytes(data.shared_files_bytes));
    set("metricSharedCount", `${data.shared_files_count} files stored`);
    set("metricPartialSize", formatBytes(data.partial_bytes));
    set("metricPartialCount", `${data.partial_count} unfinished upload(s)`);

    const messages = [];
    if (data.low_space)
      messages.push(
        `Low disk space: only ${formatBytes(data.disk_free)} free on the receive drive.`
      );
    if (data.stale_partial_count) {
      messages.push(
        `${data.stale_partial_count} unfinished upload(s) older than ${data.stale_after_hours} h are using ${formatBytes(data.stale_partial_bytes)}.`
      );
    }
    const sentinel = document.getElementById("storageSentinel");
    if (sentinel) {
      sentinel.textContent = messages.join(" ");
      sentinel.classList.toggle("hidden", !messages.length);
    }
    const staleBtn = document.getElementById("cleanStalePartialsBtn");
    if (staleBtn) {
      staleBtn.classList.toggle("hidden", !data.stale_partial_count);
      staleBtn.textContent = `Wipe ${data.stale_partial_count} stale upload(s) · ${formatBytes(data.stale_partial_bytes)}`;
    }
    document.getElementById("tabStorageDot")?.classList.toggle("hidden", !messages.length);
  } catch (err) {
    console.error("Storage info error:", err);
  }
}

export function initStorageMgrPage() {
  document.getElementById("cleanStalePartialsBtn")?.addEventListener("click", async () => {
    try {
      const data = await post("/api/clear-partials", { older_than_hours: 24 });
      showNotice(
        `Removed ${data.removed} stale upload(s) and reclaimed ${formatBytes(data.reclaimed_bytes)}.`,
        "success"
      );
      refreshStorageInfo();
    } catch (err) {
      showNotice(`Failed to clean stale uploads: ${err.message}`, "error");
    }
  });

  document.getElementById("cleanPartialsBtn")?.addEventListener("click", async () => {
    if (
      !(await confirmAction(
        "Remove all unfinished uploads?",
        "This also deletes uploads that could still be resumed. Finished files are not touched.",
        true
      ))
    )
      return;
    try {
      const data = await post("/api/clear-partials", {});
      showNotice(
        `Cleaned ${data.removed} partial file(s) and reclaimed ${formatBytes(data.reclaimed_bytes)}.`,
        "success"
      );
      refreshStorageInfo();
    } catch (err) {
      showNotice(`Failed to clean partials: ${err.message}`, "error");
    }
  });

  document.getElementById("clearHistoryBtn")?.addEventListener("click", async () => {
    if (
      !(await confirmAction(
        "Clear activity log?",
        "Transfer history is removed. Files are not touched.",
        true
      ))
    )
      return;
    try {
      await post("/api/clear-history");
      showNotice("Activity log cleared.", "success");
      refreshDevices();
      refreshStorageInfo();
    } catch (err) {
      showNotice(`Failed to clear history: ${err.message}`, "error");
    }
  });

  document.getElementById("resetStateBtn")?.addEventListener("click", async () => {
    if (
      !(await confirmAction(
        "Forget all browsers?",
        "Registered browsers and stored state are reset. Files in the shared folder are not deleted.",
        true
      ))
    )
      return;
    try {
      await post("/api/reset-state");
      showNotice("All browsers and stored state were reset.", "success");
      refreshDevices();
      refreshStorageInfo();
    } catch (err) {
      showNotice(`Failed to reset: ${err.message}`, "error");
    }
  });
}
