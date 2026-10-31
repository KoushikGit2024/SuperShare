let currentPath = "";
let currentItems = [];
let selectedItems = new Map();
let currentHostBrowsePath = "";
const deviceIdKey = "supershare-device-id";
let localDeviceId = localStorage.getItem(deviceIdKey);
if (!localDeviceId) {
  localDeviceId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9_-]/g, "");
  localStorage.setItem(deviceIdKey, localDeviceId);
}
const localDeviceName = localStorage.getItem("supershare-device-name") || (navigator.userAgentData?.platform || navigator.platform || "Browser") + " device";
const localDeviceType = /Android/i.test(navigator.userAgent) ? "Android" : /iPhone|iPad/i.test(navigator.userAgent) ? "iOS" : /Win/i.test(navigator.userAgent) ? "Windows" : /Mac/i.test(navigator.userAgent) ? "macOS" : "Browser";

function deviceHeaders() {
  return { "X-SuperShare-Device": localDeviceId, "X-SuperShare-Name": localDeviceName, "X-SuperShare-Type": localDeviceType };
}

async function refreshDevices() {
  try {
    const response = await fetch("/api/status", { headers: deviceHeaders() });
    const data = await response.json();
    const devices = data.devices || [];
    window._lastDevices = devices;
    document.getElementById("deviceCount").textContent = `${devices.length} device${devices.length === 1 ? "" : "s"}`;
    const list = document.getElementById("deviceList");
    list.replaceChildren();
    if (!devices.length) list.innerHTML = '<li class="empty-state">Waiting for devices to connect…</li>';
    devices.forEach(device => {
      const li = document.createElement("li"); li.className = "device-row";
      const main = document.createElement("div"); main.className = "device-main";
      const avatar = document.createElement("span"); avatar.className = "device-avatar"; avatar.textContent = device.type === "Android" || device.type === "iOS" ? "📱" : "💻";
      const info = document.createElement("div"); info.className = "device-info";
      const title = document.createElement("strong"); title.textContent = device.name + (device.id === localDeviceId ? " (this device)" : "");
      const meta = document.createElement("span"); meta.textContent = `${device.type} · ${device.ip || "local network"} · last seen ${new Date(device.last_seen * 1000).toLocaleTimeString()}`;
      info.append(title, meta); main.append(avatar, info);
      const state = document.createElement("span"); state.className = `device-state ${device.online ? "online" : "offline"}`; state.textContent = device.online ? "Online" : "Offline";
      li.append(main, state);
      if (device.id !== localDeviceId) {
        const controls = document.createElement("div"); controls.className = "device-controls";
        if (!device.trusted && device.approved_until < Math.floor(Date.now() / 1000)) {
          const approve = document.createElement("button"); approve.className = "btn-xs accent"; approve.textContent = "Allow 15 min"; approve.onclick = async () => { await fetch("/api/devices/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: device.id }) }); refreshDevices(); };
          const trust = document.createElement("button"); trust.className = "btn-xs outline"; trust.textContent = "Trust"; trust.onclick = async () => { await fetch("/api/devices/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: device.id, remember: true }) }); refreshDevices(); };
          controls.append(approve, trust);
        }
        const rename = document.createElement("button"); rename.className = "btn-xs outline"; rename.textContent = "Rename"; rename.onclick = async () => { const name = prompt("Device name:", device.name); if (name?.trim()) { await fetch("/api/devices/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: device.id, name: name.trim() }) }); refreshDevices(); } };
        const forget = document.createElement("button"); forget.className = "btn-xs outline"; forget.textContent = "Forget"; forget.onclick = async () => { if (confirm(`Forget ${device.name}?`)) { await fetch("/api/devices/forget", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: device.id }) }); refreshDevices(); } };
        controls.append(rename, forget); li.append(controls);
      }
      list.appendChild(li);
    });
    renderTransfers(data.transfers || []);
  } catch (_) { /* keep the last rendered state while offline */ }
}

function renderTransfers(transfers) {
  const list = document.getElementById("transferList"); list.replaceChildren();
  if (!transfers.length) { list.innerHTML = '<li class="empty-state">No transfers yet.</li>'; return; }
  [...transfers].reverse().forEach(t => {
    const li = document.createElement("li"); li.className = "transfer-row";
    const d = (window._lastDevices || []).find(item => item.id === t.device_id);
    const name = document.createElement("strong"); name.textContent = t.filename;
    const detail = document.createElement("span"); detail.textContent = `${d?.name || "Browser device"} · ${formatBytes(t.size || 0)} · ${new Date(t.timestamp * 1000).toLocaleString()}`;
    const status = document.createElement("span"); status.className = `transfer-state ${t.status}`; status.textContent = t.status;
    li.append(name, detail, status); list.appendChild(li);
  });
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024, sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function updateSelectionUI() {
  const count = selectedItems.size;
  let totalBytes = 0;
  selectedItems.forEach((meta) => {
    if (!meta.is_dir) totalBytes += meta.size || 0;
  });

  document.getElementById("selectionSummary").textContent = `${count} selected`;
  const bar = document.getElementById("selectionActionBar");
  if (count > 0) {
    bar.classList.remove("hidden");
    document.getElementById("barSelectedCount").textContent = `${count} item(s) selected`;
    document.getElementById("barSelectedSize").textContent = `Size: ${formatBytes(totalBytes)}`;
  } else {
    bar.classList.add("hidden");
  }

  const selectAllBox = document.getElementById("selectAllCheckbox");
  if (currentItems.length === 0) {
    selectAllBox.checked = false;
  } else {
    const selCount = currentItems.filter(item => selectedItems.has(currentPath ? `${currentPath}/${item.name}` : item.name)).length;
    selectAllBox.checked = selCount === currentItems.length;
  }
}

async function fetchDirectory(path = "") {
  currentPath = path;
  selectedItems.clear();
  document.getElementById("breadcrumbBar").textContent = "📍 Subpath: /" + path;
  document.getElementById("zipCurrentBtn").href = "/api/zip?path=" + encodeURIComponent(path);

  const res = await fetch("/api/list?path=" + encodeURIComponent(path));
  const data = await res.json();
  currentItems = data.items || [];
  if (data.share_root) {
    currentHostBrowsePath = data.share_root;
    document.getElementById("hostRootText").textContent = `Host: ${data.share_root}`;
  }

  const listEl = document.getElementById("fileList");
  listEl.innerHTML = "";

  if (path !== "") {
    const parent = path.split("/").slice(0, -1).join("/");
    const li = document.createElement("li");
    li.className = "file-item";
    li.innerHTML = `<div class="file-info"><a href="#" class="file-link">⬅️ .. (Back to Parent)</a></div>`;
    li.querySelector("a").onclick = (e) => { e.preventDefault(); fetchDirectory(parent); };
    listEl.appendChild(li);
  }

  if (currentItems.length === 0) {
    listEl.innerHTML += `<li class="empty-state">Folder is empty. Use "Browse Host PC Drives / Folders" above to pick any folder on your PC!</li>`;
    updateSelectionUI();
    return;
  }

  currentItems.forEach((item) => {
    const relPath = path ? `${path}/${item.name}` : item.name;
    const encoded = encodeURIComponent(relPath);
    const li = document.createElement("li");
    li.className = "file-item";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "item-checkbox";
    cb.onchange = (e) => {
      if (e.target.checked) { selectedItems.set(relPath, item); li.classList.add("selected"); }
      else { selectedItems.delete(relPath); li.classList.remove("selected"); }
      updateSelectionUI();
    };

    const left = document.createElement("div");
    left.className = "item-left";
    left.appendChild(cb);

    const info = document.createElement("div");
    info.className = "file-info";

    if (item.is_dir) {
      info.innerHTML = `<a href="#" class="file-link">📁 ${item.name}</a><div class="file-meta">Folder • Tap to open</div>`;
      info.querySelector("a").onclick = (e) => { e.preventDefault(); fetchDirectory(relPath); };
      const btn = document.createElement("a");
      btn.href = `/api/zip?path=${encoded}`;
      btn.className = "dl-btn folder";
      btn.textContent = "📦 ZIP";
      left.appendChild(info);
      li.appendChild(left);
      li.appendChild(btn);
    } else {
      info.innerHTML = `<a href="/api/download?path=${encoded}" class="file-link" download>📄 ${item.name}</a><div class="file-meta">${formatBytes(item.size)}</div>`;
      const btn = document.createElement("a");
      btn.href = `/api/download?path=${encoded}`;
      btn.className = "dl-btn";
      btn.setAttribute("download", "");
      btn.textContent = "⬇️ Save";
      left.appendChild(info);
      li.appendChild(left);
      li.appendChild(btn);
    }
    listEl.appendChild(li);
  });
  updateSelectionUI();
}

async function loadHostModalFolders(dirPath) {
  const res = await fetch("/api/host-folders?dir=" + encodeURIComponent(dirPath || ""));
  const data = await res.json();
  currentHostBrowsePath = data.current;
  document.getElementById("modalCurrentPath").textContent = "📍 " + data.current;

  const drivesBar = document.getElementById("drivesBar");
  drivesBar.innerHTML = "";
  (data.drives || []).forEach(d => {
    const b = document.createElement("button");
    b.className = "btn-xs outline";
    b.textContent = "💽 " + d.name;
    b.onclick = () => loadHostModalFolders(d.path);
    drivesBar.appendChild(b);
  });

  const list = document.getElementById("modalFolderList");
  list.innerHTML = "";
  if (data.parent) {
    const upLi = document.createElement("li");
    upLi.textContent = "⬅️ .. (Up One Level)";
    upLi.onclick = () => loadHostModalFolders(data.parent);
    list.appendChild(upLi);
  }
  (data.folders || []).forEach(f => {
    const li = document.createElement("li");
    li.textContent = "📁 " + f.name;
    li.onclick = () => loadHostModalFolders(f.path);
    list.appendChild(li);
  });
}

document.getElementById("openDriveBrowserBtn").onclick = () => {
  document.getElementById("hostModal").classList.remove("hidden");
  loadHostModalFolders(currentHostBrowsePath);
};

document.getElementById("closeModalBtn").onclick = () => {
  document.getElementById("hostModal").classList.add("hidden");
};

document.getElementById("selectThisHostFolderBtn").onclick = async () => {
  const res = await fetch("/api/set-share-dir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ share_dir: currentHostBrowsePath })
  });
  if (res.ok) {
    document.getElementById("hostModal").classList.add("hidden");
    fetchDirectory("");
  }
};

document.getElementById("nativePickerBtn").onclick = async () => {
  const res = await fetch("/api/pick-host-gui");
  if (res.ok) fetchDirectory("");
};

document.getElementById("selectAllCheckbox").onchange = (e) => {
  const check = e.target.checked;
  currentItems.forEach((item) => {
    const rel = currentPath ? `${currentPath}/${item.name}` : item.name;
    if (check) selectedItems.set(rel, item);
    else selectedItems.delete(rel);
  });
  document.querySelectorAll(".file-item").forEach(li => {
    if (check) li.classList.add("selected"); else li.classList.remove("selected");
  });
  document.querySelectorAll(".item-checkbox").forEach(cb => cb.checked = check);
  updateSelectionUI();
};

document.getElementById("downloadSelectedBtn").onclick = () => {
  if (selectedItems.size === 0) return;
  window.location.href = `/api/zip-selected?items=${encodeURIComponent(JSON.stringify(Array.from(selectedItems.keys())))}`;
};

document.getElementById("deleteSelectedBtn").onclick = async () => {
  if (!confirm(`Delete ${selectedItems.size} selected item(s)?`)) return;
  await fetch("/api/delete-selected", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: Array.from(selectedItems.keys()) })
  });
  fetchDirectory(currentPath);
};

document.getElementById("clearSelectionBtn").onclick = () => {
  selectedItems.clear();
  document.querySelectorAll(".item-checkbox").forEach(cb => cb.checked = false);
  document.querySelectorAll(".file-item").forEach(li => li.classList.remove("selected"));
  updateSelectionUI();
};

async function uploadFiles(filesList) {
  if (!filesList.length) return;
  const pBox = document.getElementById("progressContainer");
  const fName = document.getElementById("uploadFileName");
  const bar = document.getElementById("uploadBarFill");
  const pct = document.getElementById("uploadPercent");
  const spd = document.getElementById("uploadSpeed");
  pBox.classList.remove("hidden");

  for (let i = 0; i < filesList.length; i++) {
    const file = filesList[i];
    const rel = file.webkitRelativePath || file.name;
    const dest = currentPath ? `${currentPath}/${rel}` : rel;
    fName.textContent = `Uploading (${i+1}/${filesList.length}): ${rel}`;

    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const start = Date.now();
      xhr.open("POST", "/api/upload", true);
      xhr.setRequestHeader("X-File-Path", encodeURIComponent(dest));
      Object.entries(deviceHeaders()).forEach(([key, value]) => xhr.setRequestHeader(key, value));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const p = Math.round((e.loaded / e.total) * 100);
          bar.style.width = p + "%";
          pct.textContent = `${p}%`;
          const sec = (Date.now() - start) / 1000;
          if (sec > 0) spd.textContent = formatBytes(e.loaded / sec) + "/s";
        }
      };
      xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`));
      xhr.onerror = () => reject(new Error("Network error while uploading"));
      xhr.send(file);
    });
  }
  fName.textContent = "✅ Upload Complete!";
  fetchDirectory(currentPath);
  refreshDevices();
}

document.getElementById("fileInput").onchange = (e) => uploadFiles(e.target.files);
document.getElementById("folderInput").onchange = (e) => uploadFiles(e.target.files);

const dropZone = document.getElementById("dropZone");
dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("drag-active"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-active"));
dropZone.addEventListener("drop", e => { e.preventDefault(); dropZone.classList.remove("drag-active"); uploadFiles(e.dataTransfer.files); });
document.addEventListener("paste", e => {
  const files = Array.from(e.clipboardData?.files || []);
  if (files.length) uploadFiles(files);
});

document.getElementById("newFolderBtn").onclick = async () => {
  const name = prompt("New folder name:");
  if (!name) return;
  const path = currentPath ? `${currentPath}/${name}` : name;
  await fetch("/api/mkdir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
  fetchDirectory(currentPath);
};

fetchDirectory();
refreshDevices();
setInterval(refreshDevices, 5000);
