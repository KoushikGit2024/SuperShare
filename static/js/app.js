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
const localDeviceName = localStorage.getItem("supershare-device-name") || `${navigator.userAgentData?.platform || navigator.platform || "Browser"} device`;
document.getElementById("sourceDeviceName").textContent = localDeviceName;
const localDeviceType = /Android/i.test(navigator.userAgent) ? "Android" : /iPhone|iPad/i.test(navigator.userAgent) ? "iOS" : /Win/i.test(navigator.userAgent) ? "Windows" : /Mac/i.test(navigator.userAgent) ? "macOS" : "Browser";

function deviceHeaders() {
  return { "X-SuperShare-Device": localDeviceId, "X-SuperShare-Name": localDeviceName, "X-SuperShare-Type": localDeviceType };
}

function icon(name, className = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

function showNotice(message, type = "info") {
  const notice = document.getElementById("notice");
  if (!notice) return;
  notice.textContent = message;
  notice.className = `notice ${type}`;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => notice.classList.add("hidden"), 5000);
}

async function responseError(response) {
  const text = await response.text();
  try { const data = JSON.parse(text); return data.message || data.error || text; }
  catch (_) { return text || `Request failed (${response.status})`; }
}

function setConnectionState(text, type = "pending") {
  const el = document.getElementById("connectionState");
  if (!el) return;
  el.textContent = text; el.className = `connection-state ${type}`;
}

async function checkUploadPermission() {
  const response = await fetch("/api/upload-permission", { headers: deviceHeaders(), credentials: "same-origin" });
  if (!response.ok) throw new Error(`Connection check failed (${response.status})`);
  const result = await response.json();
  const canRead = Boolean(result.approved && result.permissions?.read);
  setConnectionState(result.allowed ? "Approved to send" : canRead ? "Host granted read-only access" : result.approved ? "Host granted send-only access" : result.paired ? "Waiting for host approval" : "Pair with the host", result.allowed || canRead ? "online" : "pending");
  const localHost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  document.getElementById("pairDeviceBtn").classList.toggle("hidden", result.paired || localHost);
  if (!result.paired && !localHost) setConnectionState("Pair this device to continue", "pending");
  return { canSend: Boolean(result.allowed), canRead };
}

async function pairThisDevice() {
  const code = prompt("Enter the session pairing code shown in the SuperShare host window:");
  if (!code) return;
  try {
    const response = await fetch("/api/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, id: localDeviceId, name: localDeviceName, type: localDeviceType }) });
    if (!response.ok) throw new Error(await responseError(response));
    const result = await response.json();
    showNotice("Device paired. Approve it from the laptop dashboard before sending files.", "success");
    await refreshDevices();
  } catch (error) { showNotice(error.message, "error"); }
}

async function deviceAction(url, body) {
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(await responseError(response));
    return true;
  } catch (error) {
    showNotice(error.message || "Device action failed", "error");
    return false;
  }
}

async function refreshDevices() {
  try {
    const response = await fetch("/api/status", { headers: deviceHeaders() });
    if (!response.ok) throw new Error(await responseError(response));
    const data = await response.json();
    document.getElementById("openDriveBrowserBtn").classList.toggle("hidden", !data.host_dashboard);
    document.getElementById("nativePickerBtn").classList.toggle("hidden", !data.host_dashboard);
    document.getElementById("destinationName").textContent = data.host_name || "This host";
    document.getElementById("destinationPath").textContent = data.share_root ? `${data.share_root}${currentPath ? `\\${currentPath.replaceAll("/", "\\")}` : ""}` : "Pair and get host approval to view the destination";
    const canUpload = await checkUploadPermission();
    const devices = data.devices || [];
    window._lastDevices = devices;
    document.getElementById("deviceCount").textContent = `${devices.length} device${devices.length === 1 ? "" : "s"}`;
    const list = document.getElementById("deviceList");
    list.replaceChildren();
    if (!devices.length) {
      const empty = document.createElement("li"); empty.className = "empty-state";
      empty.textContent = data.host_dashboard ? "Waiting for devices to connect…" : "Device status and approvals are managed from the laptop dashboard.";
      list.appendChild(empty);
    }
    devices.forEach(device => {
      const li = document.createElement("li"); li.className = "device-row";
      const main = document.createElement("div"); main.className = "device-main";
      const avatar = document.createElement("span"); avatar.className = "device-avatar";
      avatar.appendChild(icon(device.type === "Android" || device.type === "iOS" ? "device-mobile" : "monitor"));
      const info = document.createElement("div"); info.className = "device-info";
      const title = document.createElement("strong"); title.textContent = device.name + (device.id === localDeviceId ? " (this device)" : "");
      const meta = document.createElement("span"); meta.textContent = `${device.type} · ${device.ip || "local network"} · last seen ${new Date(device.last_seen * 1000).toLocaleTimeString()}`;
      info.append(title, meta); main.append(avatar, info);
      const paired = Boolean(device.paired);
      const accessActive = device.trusted || (device.approved_until || 0) > Math.floor(Date.now() / 1000);
      const hasPermission = Boolean(device.permissions?.read || device.permissions?.write);
      const pending = paired && !(accessActive && hasPermission);
      const state = document.createElement("span"); state.className = `device-state ${!paired || pending ? "pending" : device.online ? "online" : "offline"}`;
      if (!paired) state.append(icon("pending"), document.createTextNode(" Pairing incomplete"));
      else if (pending) state.append(icon("pending"), document.createTextNode(" Needs approval"));
      else state.textContent = `${device.online ? "Online" : "Offline"} · ${device.permissions?.read ? "Read" : ""}${device.permissions?.read && device.permissions?.write ? " + " : ""}${device.permissions?.write ? "Send" : ""}`;
      li.append(main, state);
      if (device.id !== localDeviceId) {
        const controls = document.createElement("div"); controls.className = "device-controls";
        if (pending) {
          const approve = (label, permissions, remember = false) => {
            const button = document.createElement("button"); button.className = remember ? "btn-xs outline" : "btn-xs accent"; button.textContent = label;
            button.onclick = async () => { if (await deviceAction("/api/devices/approve", { id: device.id, permissions, remember })) refreshDevices(); };
            controls.appendChild(button);
          };
          approve("Read + send · 15 min", { read: true, write: true });
          approve("Read only · 15 min", { read: true, write: false });
          approve("Send only · 15 min", { read: false, write: true });
          approve("Trust read + send", { read: true, write: true }, true);
        } else if (device.trusted || (device.approved_until || 0) > Math.floor(Date.now() / 1000)) {
          const updateAccess = (label, permissions) => {
            const button = document.createElement("button"); button.className = "btn-xs outline"; button.textContent = label;
            button.onclick = async () => { if (await deviceAction("/api/devices/approve", { id: device.id, permissions })) refreshDevices(); };
            controls.appendChild(button);
          };
          updateAccess("Read + send", { read: true, write: true });
          updateAccess("Read only", { read: true, write: false });
          updateAccess("Send only", { read: false, write: true });
          const revoke = document.createElement("button"); revoke.className = "btn-xs outline"; revoke.textContent = "Revoke access";
          revoke.onclick = async () => { if (confirm(`Revoke access for ${device.name}?`) && await deviceAction("/api/devices/revoke", { id: device.id })) refreshDevices(); };
          controls.appendChild(revoke);
        }
        const rename = document.createElement("button"); rename.className = "btn-xs outline"; rename.textContent = "Rename";
        rename.onclick = async () => { const name = prompt("Device name:", device.name); if (name?.trim() && await deviceAction("/api/devices/rename", { id: device.id, name: name.trim() })) refreshDevices(); };
        const forget = document.createElement("button"); forget.className = "btn-xs outline"; forget.textContent = "Forget";
        forget.onclick = async () => { if (confirm(`Forget ${device.name}?`) && await deviceAction("/api/devices/forget", { id: device.id })) refreshDevices(); };
        controls.append(rename, forget); li.append(controls);
      }
      list.appendChild(li);
    });
    if (data.host_dashboard) renderTransfers(data.transfers || []);
    else document.getElementById("transferList").innerHTML = '<li class="empty-state">Transfer history is available on the laptop dashboard.</li>';
    if (canUpload.canRead && !window._sharedFilesLoaded) fetchDirectory(currentPath).catch(showDirectoryError);
  } catch (_) { setConnectionState("Host unreachable", "error"); }
}

function showDirectoryError(error) {
  const list = document.getElementById("fileList"); list.replaceChildren();
  const empty = document.createElement("li"); empty.className = "empty-state";
  empty.textContent = error.message.includes("read permission")
    ? "The host has not granted this device permission to browse shared files."
    : error.message.includes("approval") || error.message.includes("Pair")
      ? "Pair this device and wait for host approval to browse shared files."
      : `Could not load this folder: ${error.message}`;
  list.appendChild(empty); showNotice(error.message, "error");
}

document.getElementById("pairDeviceBtn").addEventListener("click", pairThisDevice);

function renderTransfers(transfers) {
  const list = document.getElementById("transferList"); list.replaceChildren();
  if (!transfers.length) { list.innerHTML = '<li class="empty-state">No transfers yet.</li>'; return; }
  [...transfers].reverse().forEach(t => {
    const li = document.createElement("li"); li.className = "transfer-row";
    const device = (window._lastDevices || []).find(item => item.id === t.device_id);
    const name = document.createElement("strong"); name.textContent = t.filename;
    const detail = document.createElement("span"); detail.textContent = `From ${device?.name || "Browser device"} to ${t.destination || "shared folder"} · ${formatBytes(t.size || 0)} · ${new Date(t.timestamp * 1000).toLocaleString()}${t.detail ? ` · ${t.detail}` : ""}`;
    const status = document.createElement("span"); status.className = `transfer-state ${t.status}`; status.textContent = t.status;
    li.append(name, detail, status);
    if (t.status === "failed") {
      const retry = document.createElement("button"); retry.className = "btn-xs outline"; retry.textContent = "Choose file to retry";
      retry.title = "The browser cannot retain access to the original file after the transfer ends. Select it again to retry.";
      retry.onclick = () => {
        const input = document.createElement("input"); input.type = "file";
        input.onchange = () => { if (input.files?.length) uploadFiles(input.files, t.filename); };
        input.click();
      };
      li.appendChild(retry);
    }
    list.appendChild(li);
  });
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${parseFloat((bytes / Math.pow(1024, index)).toFixed(2))} ${units[index]}`;
}

function updateSelectionUI() {
  const count = selectedItems.size;
  let totalBytes = 0;
  selectedItems.forEach(meta => { if (!meta.is_dir) totalBytes += meta.size || 0; });
  document.getElementById("selectionSummary").textContent = `${count} selected`;
  const bar = document.getElementById("selectionActionBar");
  if (count > 0) {
    bar.classList.remove("hidden");
    document.getElementById("barSelectedCount").textContent = `${count} item(s) selected`;
    document.getElementById("barSelectedSize").textContent = `Size: ${formatBytes(totalBytes)}`;
  } else bar.classList.add("hidden");
  const selectAll = document.getElementById("selectAllCheckbox");
  const selectedCount = currentItems.filter(item => selectedItems.has(currentPath ? `${currentPath}/${item.name}` : item.name)).length;
  selectAll.checked = currentItems.length > 0 && selectedCount === currentItems.length;
}

async function fetchDirectory(path = "") {
  currentPath = path; selectedItems.clear();
  const breadcrumb = document.getElementById("breadcrumbBar");
  breadcrumb.replaceChildren(icon("home"), document.createTextNode(` Subpath: /${path}`));
  document.getElementById("zipCurrentBtn").href = "/api/zip?path=" + encodeURIComponent(path);
  const response = await fetch("/api/list?path=" + encodeURIComponent(path));
  if (!response.ok) throw new Error(await responseError(response));
  const data = await response.json();
  window._sharedFilesLoaded = true;
  currentItems = data.items || [];
  if (data.share_root) {
    currentHostBrowsePath = data.share_root;
    document.getElementById("hostRootText").textContent = `Host: ${data.share_root}`;
    document.getElementById("destinationPath").textContent = `${data.share_root}${path ? `\\${path.replaceAll("/", "\\")}` : ""}`;
  } else {
    document.getElementById("hostRootText").textContent = "Shared destination available after pairing and approval";
  }
  const list = document.getElementById("fileList"); list.replaceChildren();
  if (path) {
    const parent = path.split("/").slice(0, -1).join("/");
    const li = document.createElement("li"); li.className = "file-item";
    const info = document.createElement("div"); info.className = "file-info";
    const link = document.createElement("a"); link.href = "#"; link.className = "file-link";
    link.append(icon("arrow-up"), document.createTextNode(" .. (Back to parent)"));
    link.onclick = event => { event.preventDefault(); fetchDirectory(parent); };
    info.appendChild(link); li.appendChild(info); list.appendChild(li);
  }
  if (!currentItems.length) {
    const empty = document.createElement("li"); empty.className = "empty-state";
    empty.textContent = "Folder is empty. Browse host folders above to choose a location.";
    list.appendChild(empty); updateSelectionUI(); return;
  }
  currentItems.forEach(item => {
    const relPath = path ? `${path}/${item.name}` : item.name;
    const encoded = encodeURIComponent(relPath);
    const li = document.createElement("li"); li.className = "file-item";
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.className = "item-checkbox";
    checkbox.onchange = event => {
      if (event.target.checked) { selectedItems.set(relPath, item); li.classList.add("selected"); }
      else { selectedItems.delete(relPath); li.classList.remove("selected"); }
      updateSelectionUI();
    };
    const left = document.createElement("div"); left.className = "item-left"; left.appendChild(checkbox);
    const info = document.createElement("div"); info.className = "file-info";
    const link = document.createElement("a"); link.className = "file-link";
    if (item.is_dir) {
      link.href = "#"; link.append(icon("folder"), document.createTextNode(` ${item.name}`));
      link.onclick = event => { event.preventDefault(); fetchDirectory(relPath); };
      const meta = document.createElement("div"); meta.className = "file-meta"; meta.textContent = "Folder · Open to view contents"; info.append(link, meta);
      const button = document.createElement("a"); button.href = `/api/zip?path=${encoded}`; button.className = "dl-btn folder";
      button.append(icon("archive"), document.createTextNode(" ZIP")); left.appendChild(info); li.append(left, button);
    } else {
      link.href = `/api/download?path=${encoded}`; link.download = "";
      link.append(icon("files"), document.createTextNode(` ${item.name}`));
      const meta = document.createElement("div"); meta.className = "file-meta"; meta.textContent = formatBytes(item.size); info.append(link, meta);
      const button = document.createElement("a"); button.href = `/api/download?path=${encoded}`; button.className = "dl-btn"; button.download = "";
      button.append(icon("download"), document.createTextNode(" Save")); left.appendChild(info); li.append(left, button);
    }
    checkbox.setAttribute("aria-label", `Select ${item.name}`); list.appendChild(li);
  });
  updateSelectionUI();
}

async function loadHostModalFolders(dirPath) {
  const response = await fetch("/api/host-folders?dir=" + encodeURIComponent(dirPath || ""));
  if (!response.ok) throw new Error(await responseError(response));
  const data = await response.json(); currentHostBrowsePath = data.current;
  const modalPath = document.getElementById("modalCurrentPath");
  modalPath.replaceChildren(icon("folder-open"), document.createTextNode(` ${data.current}`));
  const drives = document.getElementById("drivesBar"); drives.replaceChildren();
  (data.drives || []).forEach(drive => {
    const button = document.createElement("button"); button.className = "btn-xs outline";
    button.append(icon("monitor"), document.createTextNode(` ${drive.name}`));
    button.onclick = () => loadHostModalFolders(drive.path); drives.appendChild(button);
  });
  const list = document.getElementById("modalFolderList"); list.replaceChildren();
  if (data.parent) {
    const up = document.createElement("li"); up.append(icon("arrow-up"), document.createTextNode(" .. (Up one level)"));
    up.onclick = () => loadHostModalFolders(data.parent); list.appendChild(up);
  }
  (data.folders || []).forEach(folder => {
    const item = document.createElement("li"); item.append(icon("folder"), document.createTextNode(` ${folder.name}`));
    item.onclick = () => loadHostModalFolders(folder.path); list.appendChild(item);
  });
}

document.getElementById("openDriveBrowserBtn").onclick = () => {
  document.getElementById("hostModal").classList.remove("hidden"); loadHostModalFolders(currentHostBrowsePath).catch(error => showNotice(error.message, "error"));
};
document.getElementById("closeModalBtn").onclick = () => document.getElementById("hostModal").classList.add("hidden");
document.getElementById("selectThisHostFolderBtn").onclick = async () => {
  const response = await fetch("/api/set-share-dir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ share_dir: currentHostBrowsePath }) });
  if (response.ok) { document.getElementById("hostModal").classList.add("hidden"); fetchDirectory(""); }
  else showNotice(await responseError(response), "error");
};
document.getElementById("nativePickerBtn").onclick = async () => {
  try { const response = await fetch("/api/pick-host-gui"); if (!response.ok) throw new Error(await responseError(response)); await fetchDirectory(""); }
  catch (error) { showNotice(error.message, "error"); }
};
document.getElementById("selectAllCheckbox").onchange = event => {
  const checked = event.target.checked;
  currentItems.forEach(item => { const path = currentPath ? `${currentPath}/${item.name}` : item.name; if (checked) selectedItems.set(path, item); else selectedItems.delete(path); });
  document.querySelectorAll(".file-item").forEach(item => { item.classList.toggle("selected", checked); });
  document.querySelectorAll(".item-checkbox").forEach(box => { box.checked = checked; }); updateSelectionUI();
};
document.getElementById("downloadSelectedBtn").onclick = () => {
  if (selectedItems.size) window.location.href = `/api/zip-selected?items=${encodeURIComponent(JSON.stringify([...selectedItems.keys()]))}`;
};
document.getElementById("deleteSelectedBtn").onclick = async () => {
  if (!confirm(`Delete ${selectedItems.size} selected item(s)?`)) return;
  const response = await fetch("/api/delete-selected", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: [...selectedItems.keys()] }) });
  if (response.ok) fetchDirectory(currentPath); else showNotice(await responseError(response), "error");
};
document.getElementById("clearSelectionBtn").onclick = () => {
  selectedItems.clear(); document.querySelectorAll(".item-checkbox").forEach(box => { box.checked = false; });
  document.querySelectorAll(".file-item").forEach(item => item.classList.remove("selected")); updateSelectionUI();
};

async function uploadFiles(files, retryName = null) {
  if (!files.length) return;
  const box = document.getElementById("progressContainer");
  const name = document.getElementById("uploadFileName");
  const bar = document.getElementById("uploadBarFill");
  const percent = document.getElementById("uploadPercent");
  const speed = document.getElementById("uploadSpeed");
  box.classList.remove("hidden");
  try {
    const access = await checkUploadPermission();
    if (!access.canSend) throw new Error("The host has not enabled send access for this device.");
  } catch (error) { showNotice(error.message, "error"); return; }
    setConnectionState(`Sending ${files.length} file${files.length === 1 ? "" : "s"}`, "online");
  try {
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const relative = retryName || file.webkitRelativePath || file.name;
      const destination = currentPath ? `${currentPath}/${relative}` : relative;
      name.textContent = `Uploading ${index + 1} of ${files.length}: ${relative}`;
      bar.style.width = "0%"; percent.textContent = "0%"; speed.textContent = "Starting";
      await new Promise((resolve, reject) => {
        const request = new XMLHttpRequest(); const start = Date.now();
        request.open("POST", "/api/upload", true);
        request.setRequestHeader("X-File-Path", encodeURIComponent(destination));
        Object.entries(deviceHeaders()).forEach(([key, value]) => request.setRequestHeader(key, value));
        request.upload.onprogress = event => {
          if (!event.lengthComputable) return;
          const progress = Math.round(event.loaded / event.total * 100);
          bar.style.width = `${progress}%`; percent.textContent = `${progress}%`;
          const seconds = (Date.now() - start) / 1000; if (seconds > 0) speed.textContent = `${formatBytes(event.loaded / seconds)}/s · ${formatBytes(event.loaded)} of ${formatBytes(event.total)}`;
        };
        request.onload = () => request.status >= 200 && request.status < 300 ? resolve() : reject(new Error(request.responseText || `Upload failed (${request.status})`));
        request.onerror = () => reject(new Error("Network error while uploading"));
        request.send(file);
      });
    }
    name.textContent = `Completed ${files.length} file${files.length === 1 ? "" : "s"}`; percent.textContent = "100%"; bar.style.width = "100%";
    document.querySelector(".running-indicator")?.classList.add("complete");
    setConnectionState("Last transfer completed", "online"); showNotice(`Sent ${files.length} file${files.length === 1 ? "" : "s"} to ${document.getElementById("destinationName").textContent}.`, "success"); fetchDirectory(currentPath); refreshDevices();
  } catch (error) { name.textContent = "Transfer failed"; document.querySelector(".running-indicator")?.classList.add("failed"); setConnectionState("Transfer failed", "error"); showNotice(error.message, "error"); refreshDevices(); }
}

document.getElementById("fileInput").onchange = event => uploadFiles(event.target.files);
document.getElementById("folderInput").onchange = event => uploadFiles(event.target.files);
const dropZone = document.getElementById("dropZone");
dropZone.addEventListener("dragover", event => { event.preventDefault(); dropZone.classList.add("drag-active"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-active"));
dropZone.addEventListener("drop", event => { event.preventDefault(); dropZone.classList.remove("drag-active"); uploadFiles(event.dataTransfer.files); });
document.addEventListener("paste", event => { const files = Array.from(event.clipboardData?.files || []); if (files.length) uploadFiles(files); });
document.getElementById("newFolderBtn").onclick = async () => {
  const name = prompt("New folder name:"); if (!name) return;
  const path = currentPath ? `${currentPath}/${name}` : name;
  const response = await fetch("/api/mkdir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
  if (response.ok) fetchDirectory(currentPath); else showNotice(await responseError(response), "error");
};

fetchDirectory().catch(showDirectoryError);
refreshDevices();
setInterval(refreshDevices, 5000);
