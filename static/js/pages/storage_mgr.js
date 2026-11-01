// static/js/pages/storage_mgr.js
// Host maintenance: Storage usage indicators, partial cleanup, log history clearance, and state reset

import { formatBytes, showNotice } from "../services/utils.js";
import { refreshDevices } from "./devices.js";

export async function refreshStorageInfo() {
  try {
    const res = await fetch("/api/storage-info");
    if (!res.ok) return;
    const data = await res.json();

    const freeEl = document.getElementById("metricFreeDisk");
    const totalEl = document.getElementById("metricTotalDisk");
    const sharedSizeEl = document.getElementById("metricSharedSize");
    const sharedCountEl = document.getElementById("metricSharedCount");
    const partSizeEl = document.getElementById("metricPartialSize");
    const partCountEl = document.getElementById("metricPartialCount");

    if (freeEl) freeEl.textContent = formatBytes(data.disk_free);
    if (totalEl) totalEl.textContent = `of ${formatBytes(data.disk_total)} total`;
    if (sharedSizeEl) sharedSizeEl.textContent = formatBytes(data.shared_files_bytes);
    if (sharedCountEl) sharedCountEl.textContent = `${data.shared_files_count} files stored`;
    if (partSizeEl) partSizeEl.textContent = formatBytes(data.partial_bytes);
    if (partCountEl) partCountEl.textContent = `${data.partial_count} partial chunks`;
  } catch (err) {
    console.error("Storage info error:", err);
  }
}

export function initStorageMgrPage() {
  document.getElementById("cleanPartialsBtn")?.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/clear-partials", { method: "POST" });
      const data = await res.json();
      showNotice(`Cleaned ${data.removed} partial file(s) and reclaimed ${formatBytes(data.reclaimed_bytes)}!`, "success");
      refreshStorageInfo();
    } catch (err) {
      showNotice(`Failed to clean partials: ${err.message}`, "error");
    }
  });

  document.getElementById("clearHistoryBtn")?.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to clear transfer history logs?")) return;
    try {
      const res = await fetch("/api/clear-history", { method: "POST" });
      const data = await res.json();
      showNotice("Transfer log history cleared.", "success");
      refreshDevices();
      refreshStorageInfo();
    } catch (err) {
      showNotice(`Failed to clear history: ${err.message}`, "error");
    }
  });

  document.getElementById("resetStateBtn")?.addEventListener("click", async () => {
    if (!confirm("Reset all registered devices and database state? (Your actual files in the folder will not be deleted)")) return;
    try {
      const res = await fetch("/api/reset-state", { method: "POST" });
      const data = await res.json();
      showNotice("All devices and stored state successfully reset.", "success");
      refreshDevices();
      refreshStorageInfo();
    } catch (err) {
      showNotice(`Failed to reset: ${err.message}`, "error");
    }
  });
}

