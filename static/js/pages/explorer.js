// static/js/pages/explorer.js
// Step 3: Browse shared files/folders, Tiles/List view switching, downloads with live size & progress,
// inline preview trigger, batch ZIP download, deletion, and folder picker modal

import { safeStorage, formatBytes, formatDuration, icon, showNotice, responseError, editText, confirmAction } from "../services/utils.js";
import { deviceHeaders, localDeviceId } from "../services/device.js";
import { canPreviewFile, openFilePreview, getFileExtension, PREVIEW_TYPES } from "../services/preview.js";
import { createQueueController } from "../services/queue.js";
import { trackTransfer } from "../services/hud.js";

export let currentPath = "";
export let currentItems = [];
export let selectedItems = new Map();
export let currentHostBrowsePath = "";

let fileViewMode = safeStorage.getItem("supershare-file-view-mode") || "grid";

export function setFileViewMode(mode) {
  fileViewMode = mode;
  safeStorage.setItem("supershare-file-view-mode", mode);
  const list = document.getElementById("fileList");
  const gridBtn = document.getElementById("viewGridBtn");
  const listBtn = document.getElementById("viewListBtn");

  if (list) list.classList.toggle("grid-view", mode === "grid");
  if (gridBtn) {
    gridBtn.classList.toggle("active", mode === "grid");
    gridBtn.setAttribute("aria-pressed", mode === "grid" ? "true" : "false");
  }
  if (listBtn) {
    listBtn.classList.toggle("active", mode === "list");
    listBtn.setAttribute("aria-pressed", mode === "list" ? "true" : "false");
  }
  if (currentItems && currentItems.length) {
    renderFileItems();
  }
}

const pathOf = item => (currentPath ? `${currentPath}/${item.name}` : item.name);

export const filterState = { query: "", type: "all" };
const TYPE_GROUPS = {
  images: PREVIEW_TYPES.img,
  videos: PREVIEW_TYPES.video,
  audio: PREVIEW_TYPES.audio,
  documents: new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "rtf", "odt", "csv"]),
  archives: new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso"])
};

export function visibleItems() {
  const query = filterState.query.trim().toLowerCase();
  return currentItems.filter(item => {
    if (query && !item.name.toLowerCase().includes(query)) return false;
    if (filterState.type === "all" || item.is_dir) return true; // folders stay visible for navigation
    return TYPE_GROUPS[filterState.type]?.has(getFileExtension(item.name)) ?? true;
  });
}

function updateFilterCount(shown) {
  const el = document.getElementById("filterCount");
  if (!el) return;
  const filtering = filterState.query.trim() || filterState.type !== "all";
  el.textContent = filtering ? `Showing ${shown} of ${currentItems.length}` : "";
}

function pruneSelectionToVisible() {
  const keep = new Set(visibleItems().map(pathOf));
  [...selectedItems.keys()].forEach(key => { if (!keep.has(key)) selectedItems.delete(key); });
}

export function clearSelection() {
  selectedItems.clear();
  document.querySelectorAll(".file-item.selected").forEach(li => li.classList.remove("selected"));
  document.querySelectorAll(".item-checkbox").forEach(box => { box.checked = false; });
  updateSelectionUI();
}

export function updateSelectionUI() {
  const count = selectedItems.size;
  const summary = document.getElementById("selectionSummary");
  if (summary) summary.textContent = `${count} selected`;
  const visible = visibleItems();
  const selectAll = document.getElementById("selectAllCheckbox");
  if (selectAll) selectAll.checked = visible.length > 0 && visible.every(item => selectedItems.has(pathOf(item)));

  const onFilesTab = !document.getElementById("storageSection")?.classList.contains("tab-hidden");
  document.getElementById("selectionActionBar")?.classList.toggle("hidden", count === 0 || !onFilesTab);
  const barCount = document.getElementById("barSelectedCount");
  if (barCount) barCount.textContent = `${count} selected`;
  const barSize = document.getElementById("barSelectedSize");
  if (barSize) {
    const items = [...selectedItems.values()];
    const bytes = items.filter(item => !item.is_dir).reduce((sum, item) => sum + (item.size || 0), 0);
    const folders = items.filter(item => item.is_dir).length;
    barSize.textContent = `${formatBytes(bytes)}${folders ? ` + ${folders} folder(s)` : ""}`;
  }
  const dlSelected = document.getElementById("downloadSelectedBtn");
  if (dlSelected) dlSelected.disabled = count === 0;
  const delSelected = document.getElementById("deleteSelectedBtn");
  if (delSelected) delSelected.disabled = count === 0;
}

let loadSeq = 0;
export async function fetchDirectory(path = "") {
  const seq = ++loadSeq;
  const response = await fetch("/api/list?path=" + encodeURIComponent(path));
  if (!response.ok) throw new Error(await responseError(response));
  const data = await response.json();
  if (seq !== loadSeq) return; // a newer navigation superseded this response

  currentPath = path;
  selectedItems.clear();
  filterState.query = "";
  const search = document.getElementById("fileSearch");
  if (search) search.value = "";

  const breadcrumb = document.getElementById("breadcrumbBar");
  if (breadcrumb) breadcrumb.replaceChildren(icon("home"), document.createTextNode(` Subpath: /${path}`));
  const zipBtn = document.getElementById("zipCurrentBtn");
  if (zipBtn) {
    zipBtn.href = "/api/zip?path=" + encodeURIComponent(path);
    zipBtn.dataset.downloadName = `${path.split("/").filter(Boolean).at(-1) || "shared-folder"}.zip`;
  }
  window._sharedFilesLoaded = true;
  currentItems = data.items || [];
  if (data.share_root) {
    currentHostBrowsePath = data.share_root;
    const hostRootEl = document.getElementById("hostRootText");
    if (hostRootEl) {
      hostRootEl.textContent = data.share_root;
      hostRootEl.title = data.share_root;
    }
    const destPathEl = document.getElementById("destinationPath");
    if (destPathEl) {
      destPathEl.textContent = `${data.share_root}${path ? `\\${path.replaceAll("/", "\\")}` : ""}`;
    }
  }
  renderFileItems();
  updateSelectionUI();
}

export function showDirectoryError(error) {
  const list = document.getElementById("fileList");
  if (!list) return;
  list.replaceChildren();
  const empty = document.createElement("li");
  empty.className = "empty-state";
  empty.textContent = `Could not load folder: ${error.message}`;
  list.appendChild(empty);
  showNotice(error.message, "error");
}

/* --- Live In-Page Download Progress Bar & Speed Tracker --- */
const MAX_IN_PAGE_DOWNLOAD_BYTES = 48 * 1024 * 1024;

let downloadCtl = null;
function downloadQueue() {
  const list = document.getElementById("downloadQueue");
  if (!list) return null;
  return (downloadCtl ||= createQueueController(list));
}

export function addDownloadRow(filename) {
  const queue = document.getElementById("downloadQueue");
  const ctl = downloadQueue();
  if (!queue || !ctl) return null;
  const row = document.createElement("li");
  row.className = "download-row";
  const info = document.createElement("div");
  info.className = "download-row-info";
  const title = document.createElement("strong");
  title.textContent = filename;
  title.title = filename;
  const state = document.createElement("span");
  state.className = "download-state";
  state.setAttribute("aria-live", "polite");
  state.textContent = "Connecting to host";
  const progress = document.createElement("progress");
  progress.max = 1;
  progress.value = 0;
  progress.setAttribute("aria-label", `Downloading ${filename}`);
  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "btn-xs outline";
  stop.textContent = "Cancel";
  info.append(title, state);
  row.append(info, stop, progress);
  queue.prepend(row);
  ctl.setState(row, "active");
  return { row, title, state, progress, stop };
}

function triggerBrowserDownload(url, filename) {
  const link = document.createElement("a");
  // Download-manager requests carry no custom headers; pass the profile id so the host can attribute them.
  link.href = url.startsWith("blob:") ? url : `${url}${url.includes("?") ? "&" : "?"}did=${encodeURIComponent(localDeviceId)}`;
  link.download = filename;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function preflightZip(url, signal) {
  const query = new URL(url, location.origin).search;
  const response = await fetch(`/api/zip-preflight${query}`, { headers: deviceHeaders(), credentials: "same-origin", signal });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json();
}

export async function startTrackedDownload(url, filename, expectedSize = 0) {
  const item = addDownloadRow(filename);
  if (!item) {
    triggerBrowserDownload(url, filename);
    return;
  }
  const ctl = downloadQueue();
  const tracker = trackTransfer({ kind: "download", label: filename });
  const controller = new AbortController();
  let outcome = "failed", writer = null, reader = null, saveHandle = null, total = expectedSize;
  let rate = 0, received = 0;

  const settle = (kind, text) => {
    outcome = kind;
    item.state.textContent = text;
    item.stop.remove();
    if (kind !== "complete") item.progress.hidden = true; // no half-rendered bars after cancel/fail
    item.row.classList.add(`download-${kind}`);
    ctl.setState(item.row, kind);
  };
  const handOff = reason => {
    triggerBrowserDownload(url, filename);
    settle("complete", reason);
  };
  item.stop.onclick = () => controller.abort();

  try {
    if (url.startsWith("/api/zip")) {
      item.state.textContent = "Checking folder contents…";
      const check = await preflightZip(url, controller.signal);
      if (check.empty) {
        settle("skipped", "Nothing to download · this selection has no files");
        showNotice("Nothing to download: the selection contains no files.", "info");
        return;
      }
      total = check.bytes;
    }

    if (window.isSecureContext && "showSaveFilePicker" in window) {
      try {
        saveHandle = await window.showSaveFilePicker({ suggestedName: filename });
      } catch (error) {
        if (error.name === "AbortError") throw error;
      }
    }
    const limit = url.startsWith("/api/zip") ? MAX_IN_PAGE_DOWNLOAD_BYTES * 0.8 : MAX_IN_PAGE_DOWNLOAD_BYTES;
    if (!saveHandle && (!total || total > limit)) {
      item.progress.removeAttribute("value");
      handOff(`${total ? `${formatBytes(total)} · ` : ""}Handed to the browser's download manager`);
      return;
    }

    const response = await fetch(url, { credentials: "same-origin", headers: deviceHeaders(), signal: controller.signal });
    if (!response.ok) throw new Error(await responseError(response));
    total = Number(response.headers.get("Content-Length")) || total || 0;
    reader = response.body?.getReader();
    if (!reader) throw new Error("This browser cannot stream the download. Try a current browser.");
    if (!saveHandle && total > MAX_IN_PAGE_DOWNLOAD_BYTES) {
      await reader.cancel();
      handOff(`Large file (${formatBytes(total)}) handed to the browser's download manager`);
      return;
    }

    if (saveHandle) writer = await saveHandle.createWritable();
    const chunks = [];
    const startedAt = performance.now();
    let lastTime = startedAt, lastBytes = 0, lastRender = 0;
    item.state.textContent = total ? `Starting · ${formatBytes(total)}` : "Receiving…";

    const render = () => {
      const now = performance.now();
      const elapsed = (now - lastTime) / 1000;
      if (elapsed >= 0.25) {
        const instant = (received - lastBytes) / elapsed;
        rate = rate ? rate * 0.7 + instant * 0.3 : instant;
        lastTime = now;
        lastBytes = received;
      }
      if (total) {
        item.progress.max = total;
        item.progress.value = Math.min(received, total);
      } else {
        item.progress.removeAttribute("value");
      }
      const pct = total ? ` · ${Math.min(100, Math.floor(received / total * 100))}%` : "";
      const speed = rate > 0 ? ` · ${formatBytes(rate)}/s` : "";
      const eta = total && rate > 0 && received < total ? ` · ETA ${formatDuration((total - received) / rate)}` : "";
      item.state.textContent = `${formatBytes(received)}${total ? ` of ${formatBytes(total)}` : " received"}${pct}${speed}${eta}`;
      tracker.update({ done: received, total, rate });
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (!saveHandle && received > MAX_IN_PAGE_DOWNLOAD_BYTES) {
        await reader.cancel();
        chunks.length = 0;
        handOff("Large file handed to the browser's download manager; follow progress there.");
        return;
      }
      if (writer) await writer.write(value);
      else chunks.push(value);
      if (performance.now() - lastRender >= 100) {
        lastRender = performance.now();
        render();
      }
    }

    if (writer) {
      await writer.close();
    } else {
      const blob = new Blob(chunks, { type: response.headers.get("Content-Type") || "application/octet-stream" });
      const objectUrl = URL.createObjectURL(blob);
      triggerBrowserDownload(objectUrl, filename);
      chunks.length = 0;
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    }

    const seconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
    item.progress.max = Math.max(received, 1);
    item.progress.value = Math.max(received, 1);
    tracker.update({ done: received, total: received, rate: 0 });
    settle("complete", `Saved · ${formatBytes(received)} in ${formatDuration(seconds)} · avg ${formatBytes(received / seconds)}/s`);
  } catch (error) {
    try { await reader?.cancel(); } catch (_) {}
    try { await writer?.abort(); } catch (_) {}
    if (error.name === "AbortError") {
      settle("cancelled", "Download cancelled");
    } else {
      settle("failed", `Download failed · ${error.message}`);
      ctl.setRetry(item.row, () => startTrackedDownload(url, filename, expectedSize));
      showNotice(error.message, "error");
    }
  } finally {
    tracker.finish(outcome);
  }
}

export function renderFileItems() {
  const list = document.getElementById("fileList");
  if (!list) return;
  list.replaceChildren();
  list.classList.toggle("grid-view", fileViewMode === "grid");
  const visible = visibleItems();
  updateFilterCount(visible.length);

  if (currentPath) {
    const parent = currentPath.split("/").slice(0, -1).join("/");
    const li = document.createElement("li");
    li.className = "file-item parent-nav-item";

    if (fileViewMode === "grid") {
      const thumb = document.createElement("div");
      thumb.className = "tile-thumb-container";
      const ph = document.createElement("div");
      ph.className = "tile-icon-placeholder folder-icon";
      ph.appendChild(icon("folder-up"));
      thumb.appendChild(ph);
      thumb.onclick = () => fetchDirectory(parent).catch(showDirectoryError);

      const info = document.createElement("div");
      info.className = "tile-info";
      const name = document.createElement("a");
      name.href = "#";
      name.className = "tile-name";
      name.textContent = ".. (Back to parent)";
      name.onclick = e => { e.preventDefault(); fetchDirectory(parent).catch(showDirectoryError); };
      info.appendChild(name);
      li.append(thumb, info);
    } else {
      const left = document.createElement("div");
      left.className = "item-left";
      const info = document.createElement("div");
      info.className = "file-info";
      const link = document.createElement("a");
      link.href = "#";
      link.className = "file-link";
      link.append(icon("folder-up"), document.createTextNode(" .. (Back to parent)"));
      link.onclick = event => { event.preventDefault(); fetchDirectory(parent).catch(showDirectoryError); };
      info.appendChild(link);
      left.appendChild(info);
      li.appendChild(left);
    }
    list.appendChild(li);
  }

  if (!visible.length) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = currentItems.length ? "No items match this filter." : "This folder is empty.";
    list.appendChild(empty);
    updateSelectionUI();
    return;
  }

  visible.forEach(item => {
    const relItemPath = currentPath ? `${currentPath}/${item.name}` : item.name;
    const isSelected = selectedItems.has(relItemPath);
    const ext = getFileExtension(item.name);
    const previewable = canPreviewFile(item.name);

    const li = document.createElement("li");
    li.className = `file-item ${item.is_dir ? "is-folder" : "is-file"} ${isSelected ? "selected" : ""}`;

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "item-checkbox";
    check.checked = isSelected;
    check.onclick = e => {
      e.stopPropagation();
      if (check.checked) selectedItems.set(relItemPath, item);
      else selectedItems.delete(relItemPath);
      li.classList.toggle("selected", check.checked);
      updateSelectionUI();
    };

    if (fileViewMode === "grid") {
      // ===== TILES / GRID VIEW =====
      const thumb = document.createElement("div");
      thumb.className = "tile-thumb-container";

      if (item.is_dir) {
        const ph = document.createElement("div");
        ph.className = "tile-icon-placeholder folder-icon";
        ph.appendChild(icon("folder"));
        thumb.appendChild(ph);
        thumb.onclick = () => fetchDirectory(relItemPath).catch(showDirectoryError);
      } else if (PREVIEW_TYPES.img.has(ext)) {
        const img = document.createElement("img");
        img.className = "tile-thumb-img";
        img.src = `/api/preview?path=${encodeURIComponent(relItemPath)}`;
        img.alt = item.name;
        img.loading = "lazy";
        thumb.appendChild(img);
        thumb.onclick = () => openFilePreview(relItemPath, item.name, item.size || 0);
      } else {
        const ph = document.createElement("div");
        ph.className = "tile-icon-placeholder";
        const iconType = PREVIEW_TYPES.audio.has(ext) ? "music" : PREVIEW_TYPES.video.has(ext) ? "monitor" : PREVIEW_TYPES.pdf.has(ext) ? "files" : "file";
        ph.appendChild(icon(iconType));
        thumb.appendChild(ph);
        if (previewable) {
          thumb.onclick = () => openFilePreview(relItemPath, item.name, item.size || 0);
        } else {
          thumb.onclick = () => startTrackedDownload(`/api/download?path=${encodeURIComponent(relItemPath)}`, item.name, item.size);
        }
      }

      const badge = document.createElement("span");
      badge.className = "tile-badge";
      badge.textContent = item.is_dir ? "DIR" : (ext ? ext.toUpperCase() : "FILE");
      thumb.appendChild(badge);

      const info = document.createElement("div");
      info.className = "tile-info";
      const nameLink = document.createElement("a");
      nameLink.href = "#";
      nameLink.className = "tile-name";
      nameLink.title = item.name;
      nameLink.textContent = item.name;
      if (item.is_dir) {
        nameLink.onclick = e => { e.preventDefault(); fetchDirectory(relItemPath).catch(showDirectoryError); };
      } else if (previewable) {
        nameLink.onclick = e => { e.preventDefault(); openFilePreview(relItemPath, item.name, item.size || 0); };
      } else {
        nameLink.onclick = e => { e.preventDefault(); startTrackedDownload(`/api/download?path=${encodeURIComponent(relItemPath)}`, item.name, item.size); };
      }
      info.appendChild(nameLink);

      const meta = document.createElement("div");
      meta.className = "tile-meta";
      meta.textContent = item.is_dir ? "Folder" : formatBytes(item.size);
      info.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "tile-actions";

      if (item.is_dir) {
        const zipBtn = document.createElement("button");
        zipBtn.type = "button";
        zipBtn.className = "dl-btn folder";
        zipBtn.append(icon("archive"), document.createTextNode(" ZIP"));
        zipBtn.onclick = () => startTrackedDownload(`/api/zip?path=${encodeURIComponent(relItemPath)}`, `${item.name}.zip`, 0);
        actions.appendChild(zipBtn);
      } else {
        if (previewable) {
          const prevBtn = document.createElement("button");
          prevBtn.type = "button";
          prevBtn.className = "btn-preview";
          prevBtn.append(icon("monitor"), document.createTextNode(" View"));
          prevBtn.onclick = e => {
            e.stopPropagation();
            openFilePreview(relItemPath, item.name, item.size || 0);
          };
          actions.appendChild(prevBtn);
        }
        const saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.className = "dl-btn";
        saveBtn.append(icon("download"), document.createTextNode(" Save"));
        saveBtn.onclick = () => startTrackedDownload(`/api/download?path=${encodeURIComponent(relItemPath)}`, item.name, item.size);
        actions.appendChild(saveBtn);
      }

      li.append(check, thumb, info, actions);
    } else {
      // ===== TRADITIONAL LIST VIEW =====
      const left = document.createElement("div");
      left.className = "item-left";
      left.appendChild(check);

      const info = document.createElement("div");
      info.className = "file-info";
      const link = document.createElement("a");
      link.className = "file-link";

      if (item.is_dir) {
        link.href = "#";
        link.append(icon("folder"), document.createTextNode(` ${item.name}`));
        link.onclick = event => { event.preventDefault(); fetchDirectory(relItemPath).catch(showDirectoryError); };
        const meta = document.createElement("div");
        meta.className = "file-meta";
        meta.textContent = `Folder · ${item.mtime ? new Date(item.mtime * 1000).toLocaleDateString() : ""}`;
        info.append(link, meta);
        left.appendChild(info);

        const button = document.createElement("button");
        button.type = "button";
        button.className = "dl-btn folder";
        button.append(icon("archive"), document.createTextNode(" ZIP"));
        button.onclick = () => startTrackedDownload(`/api/zip?path=${encodeURIComponent(relItemPath)}`, `${item.name}.zip`, 0);
        li.append(left, button);
      } else {
        link.href = "#";
        link.append(icon("file"), document.createTextNode(` ${item.name}`));
        if (previewable) {
          link.onclick = event => { event.preventDefault(); openFilePreview(relItemPath, item.name, item.size || 0); };
        } else {
          link.onclick = event => { event.preventDefault(); startTrackedDownload(`/api/download?path=${encodeURIComponent(relItemPath)}`, item.name, item.size); };
        }
        const meta = document.createElement("div");
        meta.className = "file-meta";
        meta.textContent = `${formatBytes(item.size)} · ${item.mtime ? new Date(item.mtime * 1000).toLocaleDateString() : ""}`;
        info.append(link, meta);
        left.appendChild(info);

        const actionGroup = document.createElement("div");
        actionGroup.className = "action-group";
        actionGroup.style.display = "flex";
        actionGroup.style.gap = "6px";

        if (previewable) {
          const prevBtn = document.createElement("button");
          prevBtn.type = "button";
          prevBtn.className = "btn-preview";
          prevBtn.append(icon("monitor"), document.createTextNode(" Preview"));
          prevBtn.onclick = () => openFilePreview(relItemPath, item.name, item.size || 0);
          actionGroup.appendChild(prevBtn);
        }

        const button = document.createElement("button");
        button.type = "button";
        button.className = "dl-btn";
        button.append(icon("download"), document.createTextNode(" Save"));
        button.onclick = () => startTrackedDownload(`/api/download?path=${encodeURIComponent(relItemPath)}`, item.name, item.size);
        actionGroup.appendChild(button);

        li.append(left, actionGroup);
      }
    }

    list.appendChild(li);
  });
}

export async function loadHostModalFolders(dirPath) {
  const response = await fetch("/api/host-folders?dir=" + encodeURIComponent(dirPath || ""));
  if (!response.ok) throw new Error(await responseError(response));
  const data = await response.json();
  currentHostBrowsePath = data.current;
  const modalPath = document.getElementById("modalCurrentPath");
  if (modalPath) modalPath.replaceChildren(icon("folder-open"), document.createTextNode(` ${data.current}`));
  const drives = document.getElementById("drivesBar");
  if (drives) {
    drives.replaceChildren();
    (data.drives || []).forEach(drive => {
      const button = document.createElement("button");
      button.className = "btn-xs outline";
      button.append(icon("monitor"), document.createTextNode(` ${drive.name}`));
      button.onclick = () => loadHostModalFolders(drive.path);
      drives.appendChild(button);
    });
  }
  const list = document.getElementById("modalFolderList");
  if (list) {
    list.replaceChildren();
    if (data.parent) {
      const up = document.createElement("li");
      up.append(icon("arrow-up"), document.createTextNode(" .. (Up one level)"));
      up.onclick = () => loadHostModalFolders(data.parent);
      list.appendChild(up);
    }
    (data.folders || []).forEach(folder => {
      const item = document.createElement("li");
      item.append(icon("folder"), document.createTextNode(` ${folder.name}`));
      item.onclick = () => loadHostModalFolders(folder.path);
      list.appendChild(item);
    });
  }
}

export function initExplorerPage() {
  document.getElementById("viewGridBtn")?.addEventListener("click", () => setFileViewMode("grid"));
  document.getElementById("viewListBtn")?.addEventListener("click", () => setFileViewMode("list"));

  document.getElementById("zipCurrentBtn")?.addEventListener("click", event => {
    event.preventDefault();
    const btn = document.getElementById("zipCurrentBtn");
    startTrackedDownload(btn.href, btn.dataset.downloadName || "shared-folder.zip", 0);
  });

  document.getElementById("selectAllCheckbox")?.addEventListener("change", event => {
    const checked = event.target.checked;
    visibleItems().forEach(item => {
      const path = currentPath ? `${currentPath}/${item.name}` : item.name;
      if (checked) selectedItems.set(path, item);
      else selectedItems.delete(path);
    });
    document.querySelectorAll(".file-item").forEach(item => item.classList.toggle("selected", checked));
    document.querySelectorAll(".item-checkbox").forEach(box => { box.checked = checked; });
    updateSelectionUI();
  });

  document.getElementById("downloadSelectedBtn")?.addEventListener("click", () => {
    if (selectedItems.size) {
      const keys = [...selectedItems.keys()];
      const url = `/api/zip-selected?items=${encodeURIComponent(JSON.stringify(keys))}`;
      startTrackedDownload(url, `supershare_selected_${selectedItems.size}.zip`, 0);
    }
  });

  document.getElementById("deleteSelectedBtn")?.addEventListener("click", async () => {
    if (!await confirmAction("Delete selected items?", `This permanently removes ${selectedItems.size} item(s) from the host folder.`, true)) return;
    const response = await fetch("/api/delete-selected", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...deviceHeaders() },
      body: JSON.stringify({ items: [...selectedItems.keys()] })
    });
    if (response.ok) fetchDirectory(currentPath);
    else showNotice(await responseError(response), "error");
  });

  document.getElementById("newFolderBtn")?.addEventListener("click", async () => {
    const name = await editText("Create a folder", "The folder will be created inside the current shared location.", "Folder name");
    if (!name) return;
    const path = currentPath ? `${currentPath}/${name}` : name;
    const response = await fetch("/api/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...deviceHeaders() },
      body: JSON.stringify({ path })
    });
    if (response.ok) fetchDirectory(currentPath);
    else showNotice(await responseError(response), "error");
  });

  document.getElementById("openDriveBrowserBtn")?.addEventListener("click", () => {
    document.getElementById("hostModal")?.classList.remove("hidden");
    loadHostModalFolders(currentHostBrowsePath).catch(error => showNotice(error.message, "error"));
  });

  document.getElementById("closeModalBtn")?.addEventListener("click", () => {
    document.getElementById("hostModal")?.classList.add("hidden");
  });

  document.getElementById("selectThisHostFolderBtn")?.addEventListener("click", async () => {
    const response = await fetch("/api/set-share-dir", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...deviceHeaders() },
      body: JSON.stringify({ share_dir: currentHostBrowsePath })
    });
    if (response.ok) {
      document.getElementById("hostModal")?.classList.add("hidden");
      fetchDirectory("");
    } else {
      showNotice(await responseError(response), "error");
    }
  });

  document.getElementById("nativePickerBtn")?.addEventListener("click", async () => {
    try {
      const response = await fetch("/api/pick-host-gui", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...deviceHeaders() },
        body: "{}"
      });
      if (!response.ok) throw new Error(await responseError(response));
      await fetchDirectory("");
    } catch (error) {
      showNotice(error.message, "error");
    }
  });
}


export function initExplorerEnhancements() {
  const search = document.getElementById("fileSearch");
  let timer = 0;
  const refilter = () => { pruneSelectionToVisible(); renderFileItems(); updateSelectionUI(); };

  search?.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { filterState.query = search.value; refilter(); }, 120);
  });

  document.querySelectorAll(".type-chips .chip").forEach(chip => {
    chip.addEventListener("click", () => {
      filterState.type = chip.dataset.type;
      document.querySelectorAll(".type-chips .chip").forEach(other => {
        const on = other === chip;
        other.classList.toggle("active", on);
        other.setAttribute("aria-pressed", String(on));
      });
      refilter();
    });
  });

  document.getElementById("clearSelectionBtn")?.addEventListener("click", clearSelection);

  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (document.querySelector("dialog[open]")) return;
    const hostModal = document.getElementById("hostModal");
    if (hostModal && !hostModal.classList.contains("hidden")) { hostModal.classList.add("hidden"); return; }
    const preview = document.getElementById("previewModal");
    if (preview && !preview.classList.contains("hidden")) return; // preview.js owns this Escape
    if (document.getElementById("hudDrawer")?.classList.contains("hidden") === false) return; // HUD owns this Escape
    if (search && document.activeElement === search && search.value) {
      search.value = "";
      filterState.query = "";
      refilter();
      return;
    }
    if (selectedItems.size) clearSelection();
  });
}
