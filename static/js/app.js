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

let preferredConnectionUrl = "";
let networkTlsEnabled = false;
const pairingCodeFromQr = new URLSearchParams(location.search).get("pair_code");
async function refreshNetworkInfo() {
  const addresses = document.getElementById("networkAddresses");
  const status = document.getElementById("networkStatus");
  try {
    const response = await fetch("/api/network", { cache: "no-store" });
    if (!response.ok) throw new Error(await responseError(response));
    const info = await response.json();
    addresses.replaceChildren();
    const networkInterfaces = info.interfaces?.length ? info.interfaces : (info.addresses || []).map(address => ({ name: "Network adapter", address }));
    const candidates = networkInterfaces.length ? networkInterfaces : [{ name: "Current connection", address: location.hostname }];
    candidates.forEach(adapter => {
      const scheme = info.scheme || location.protocol.replace(":", "");
      const entry = document.createElement("code"); entry.textContent = `${adapter.name}: ${scheme}://${adapter.address}:${info.port}/`;
      entry.title = adapter.netmask ? `IPv4 ${adapter.address} · mask ${adapter.netmask}${adapter.broadcast ? ` · broadcast ${adapter.broadcast}` : ""}` : adapter.address;
      addresses.appendChild(entry);
    });
    preferredConnectionUrl = `${info.scheme || location.protocol.replace(":", "")}://${candidates[0].address}:${info.port}/`;
    const security = document.getElementById("networkSecurity");
    const secure = info.scheme === "https";
    networkTlsEnabled = secure;
    security.classList.toggle("secure", secure);
    security.textContent = secure
      ? `HTTPS enabled · CA SHA-256: ${info.ca_fingerprint || "fingerprint unavailable"}. Verify it on native clients and trust the local CA for browsers.`
      : "HTTP mode · pairing codes and file data are unencrypted on the local network. Use only a trusted private hotspot or restart with --https.";
    let extra = "";
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
      const diagnosticResponse = await fetch("/api/diagnostics", { cache: "no-store" });
      if (diagnosticResponse.ok) {
        const diagnostic = await diagnosticResponse.json();
        extra = diagnostic.storage?.available_bytes != null ? ` · ${formatBytes(diagnostic.storage.available_bytes)} free on receive drive` : "";
      }
    }
    status.textContent = `Service reachable · TCP ${info.port} · Pairing required · Internet not required${extra}`;
    status.classList.remove("error");
  } catch (error) {
    status.textContent = `Connection diagnostics unavailable: ${error.message}`;
    status.classList.add("error");
  }
}

document.getElementById("copyConnectionBtn").addEventListener("click", async () => {
  try {
    if (!preferredConnectionUrl) await refreshNetworkInfo();
    await navigator.clipboard.writeText(preferredConnectionUrl || location.href);
    showNotice("Connection address copied. Open it on a device connected to this hotspot.", "success");
  } catch (_) { showNotice("Could not copy the connection address. Select and copy it from the Network section.", "error"); }
});

document.getElementById("showPairQrBtn").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/pairing-qr", { cache: "no-store" });
    if (!response.ok) throw new Error(await responseError(response));
    const panel = document.getElementById("pairQrPanel");
    const image = document.getElementById("pairQrImage");
    if (image.dataset.objectUrl) URL.revokeObjectURL(image.dataset.objectUrl);
    image.dataset.objectUrl = URL.createObjectURL(await response.blob());
    image.src = image.dataset.objectUrl;
    panel.classList.remove("hidden");
  } catch (error) { showNotice(error.message, "error"); }
});

document.getElementById("copyTlsFingerprintBtn").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/network", { cache: "no-store" });
    const info = await response.json();
    await navigator.clipboard.writeText(info.ca_fingerprint || "");
    showNotice("TLS CA fingerprint copied. Compare it with the value printed in the host terminal.", "success");
  } catch (_) { showNotice("Could not copy the TLS fingerprint.", "error"); }
});

async function checkUploadPermission() {
  const response = await fetch("/api/upload-permission", { headers: deviceHeaders(), credentials: "same-origin" });
  if (!response.ok) throw new Error(`Connection check failed (${response.status})`);
  const result = await response.json();
  const canRead = Boolean(result.approved && result.permissions?.read);
  const phrasePanel = document.getElementById("pairPhrasePanel");
  phrasePanel.classList.toggle("hidden", !result.paired || result.pair_confirmed || !result.verification_phrase);
  if (result.verification_phrase) document.getElementById("pairPhrase").textContent = result.verification_phrase;
  setConnectionState(result.allowed ? "Approved to send" : canRead ? "Host granted read-only access" : result.approved ? "Host granted send-only access" : result.paired ? "Waiting for host approval" : "Pair with the host", result.allowed || canRead ? "online" : "pending");
  const localHost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  document.getElementById("pairDeviceBtn").classList.toggle("hidden", result.paired || localHost);
  if (!result.paired && !localHost) setConnectionState("Pair this device to continue", "pending");
  return { canSend: Boolean(result.allowed), canRead };
}

async function pairThisDevice() {
  const code = pairingCodeFromQr || prompt("Enter the session pairing code shown in the SuperShare host window:");
  if (!code) return;
  try {
    const response = await fetch("/api/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, id: localDeviceId, name: localDeviceName, type: localDeviceType }) });
    if (!response.ok) throw new Error(await responseError(response));
    const result = await response.json();
    if (pairingCodeFromQr) history.replaceState({}, "", location.pathname);
    showNotice("Compare the verification phrase on the laptop, then confirm it here.", "success");
    await refreshDevices();
  } catch (error) { showNotice(error.message, "error"); }
}

async function confirmPairingPhrase() {
  const response = await fetch("/api/devices/confirm-pairing", { method: "POST", headers: deviceHeaders(), credentials: "same-origin" });
  if (!response.ok) { showNotice(await responseError(response), "error"); return; }
  showNotice("Phrase confirmed. The laptop can now grant this device access.", "success");
  refreshDevices();
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
    document.getElementById("showPairQrBtn").classList.toggle("hidden", !data.host_dashboard);
    document.getElementById("copyTlsFingerprintBtn").classList.toggle("hidden", !data.host_dashboard || !networkTlsEnabled);
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
      const phraseText = device.paired && !device.pair_confirmed && device.verification_phrase ? ` · Verify phrase: ${device.verification_phrase}` : "";
      const meta = document.createElement("span"); meta.textContent = `${device.type} · ${device.ip || "local network"} · last seen ${new Date(device.last_seen * 1000).toLocaleTimeString()}${phraseText}`;
      info.append(title, meta); main.append(avatar, info);
      const paired = Boolean(device.paired);
      const phraseConfirmed = Boolean(device.pair_confirmed);
      const accessActive = device.trusted || (device.approved_until || 0) > Math.floor(Date.now() / 1000);
      const hasPermission = Boolean(device.permissions?.read || device.permissions?.write);
      const pending = paired && !(phraseConfirmed && accessActive && hasPermission);
      const state = document.createElement("span"); state.className = `device-state ${!paired || pending ? "pending" : device.online ? "online" : "offline"}`;
      if (!paired) state.append(icon("pending"), document.createTextNode(" Pairing incomplete"));
      else if (!phraseConfirmed) state.append(icon("pending"), document.createTextNode(" Verify phrase"));
      else if (pending) state.append(icon("pending"), document.createTextNode(" Needs approval"));
      else state.textContent = `${device.online ? "Online" : "Offline"} · ${device.permissions?.read ? "Read" : ""}${device.permissions?.read && device.permissions?.write ? " + " : ""}${device.permissions?.write ? "Send" : ""}`;
      li.append(main, state);
      if (device.id !== localDeviceId) {
        const controls = document.createElement("div"); controls.className = "device-controls";
        if (pending && phraseConfirmed) {
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
    window._lastTransfers = data.transfers || [];
    if (data.host_dashboard) renderTransfers(window._lastTransfers);
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
document.getElementById("confirmPairingBtn").addEventListener("click", confirmPairingPhrase);

function renderTransfers(transfers) {
  const list = document.getElementById("transferList"); list.replaceChildren();
  const filter = document.getElementById("transferFilter")?.value || "all";
  const filtered = [...transfers].reverse().filter(t => filter === "all" || (filter === "active" ? ["queued", "transferring", "interrupted", "verifying"].includes(t.status) : t.status === filter));
  if (!filtered.length) { const empty = document.createElement("li"); empty.className = "empty-state"; empty.textContent = filter === "all" ? "No transfers yet." : `No ${filter} transfers.`; list.appendChild(empty); return; }
  filtered.forEach(t => {
    const li = document.createElement("li"); li.className = "transfer-row";
    const device = (window._lastDevices || []).find(item => item.id === t.device_id);
    const name = document.createElement("strong"); name.textContent = t.filename;
    const progressText = t.offset != null ? ` · ${formatBytes(t.offset)} of ${formatBytes(t.size || 0)}` : "";
    const from = t.direction === "send" ? "SuperShare host" : (device?.name || "Browser device");
    const to = t.direction === "send" ? (device?.name || t.destination || "connected device") : (t.destination || "shared folder");
    const detail = document.createElement("span"); detail.textContent = `From ${from} to ${to} · ${formatBytes(t.size || 0)}${progressText} · ${new Date((t.timestamp || t.updated_at) * 1000).toLocaleString()}${t.detail ? ` · ${t.detail}` : ""}`;
    const status = document.createElement("span"); status.className = `transfer-state ${t.status}`; status.textContent = t.status;
    li.append(name, detail, status);
    if (["queued", "transferring", "interrupted", "verifying"].includes(t.status)) {
      const cancel = document.createElement("button"); cancel.className = "btn-xs outline"; cancel.textContent = "Cancel";
      cancel.onclick = async () => {
        if (!confirm(`Cancel transfer of ${t.filename}? Its partial file will be removed.`)) return;
        const response = await fetch(`/api/transfers/${encodeURIComponent(t.id)}/cancel`, { method: "POST" });
        if (!response.ok) showNotice(await responseError(response), "error"); else refreshDevices();
      };
      li.appendChild(cancel);
    }
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

document.getElementById("transferFilter").addEventListener("change", () => renderTransfers(window._lastTransfers || []));

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${parseFloat((bytes / Math.pow(1024, index)).toFixed(2))} ${units[index]}`;
}

const SHA256_K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);

function sha256Bytes(message) {
  const length = message.length;
  const paddedLength = Math.ceil((length + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength); data.set(message); data[length] = 0x80;
  const bitLength = length * 8;
  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const hash = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const words = new Uint32Array(64);
  const rotate = (value, count) => (value >>> count) | (value << (32 - count));
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const a = words[index - 15], b = words[index - 2];
      const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3);
      const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let index = 0; index < 64; index++) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choose + SHA256_K[index] + words[index]) >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
  }
  return [...hash].map(value => value.toString(16).padStart(8, "0")).join("");
}

async function sha256Blob(blob) {
  const bytes = await blob.arrayBuffer();
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
  }
  return sha256Bytes(new Uint8Array(bytes));
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
  let skippedFiles = 0;
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
        (async () => {
          const start = Date.now();
          const headers = { "Content-Type": "application/json", ...deviceHeaders() };
          const resumeKey = `supershare-transfer:${localDeviceId}:${destination}:${file.name}:${file.size}:${file.lastModified}`;
          const resumeId = localStorage.getItem(resumeKey) || "";
          let collision = "ask";
          let created = await fetch("/api/transfers", { method: "POST", headers, credentials: "same-origin", body: JSON.stringify({ name: file.name, size: file.size, path: destination, resume_id: resumeId, collision }) });
          if (created.status === 409) {
            const choice = prompt(`A file named "${file.name}" already exists. Choose skip, rename, replace, or cancel. Replacing overwrites the existing file after the new transfer verifies.`, "rename");
            collision = (choice || "cancel").trim().toLowerCase();
            if (collision === "cancel") { skippedFiles++; resolve(); return; }
            if (!["skip", "rename", "replace"].includes(collision)) throw new Error("Choose skip, rename, replace, or cancel.");
            if (collision === "replace" && !confirm(`Replace ${file.name} after the incoming file verifies?`)) { resolve(); return; }
            created = await fetch("/api/transfers", { method: "POST", headers, credentials: "same-origin", body: JSON.stringify({ name: file.name, size: file.size, path: destination, collision }) });
          }
          if (!created.ok) throw new Error(await responseError(created));
          const session = await created.json();
          if (session.status === "skipped") { skippedFiles++; resolve(); return; }
          localStorage.setItem(resumeKey, session.id);
          let offset = session.offset || 0;
          const chunkSize = session.chunk_size;
          while (offset < file.size) {
            const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size));
            const chunkChecksum = await sha256Blob(chunk);
            const response = await fetch(`/api/transfers/${session.id}/chunk`, { method: "PUT", headers: { ...deviceHeaders(), "X-Chunk-Offset": String(offset), "X-Chunk-SHA256": chunkChecksum }, credentials: "same-origin", body: chunk });
            if (!response.ok) throw new Error(await responseError(response));
            const result = await response.json(); offset = result.offset;
            const progress = file.size ? Math.round(offset / file.size * 100) : 100;
            bar.style.width = `${progress}%`; percent.textContent = `${progress}%`;
            const seconds = (Date.now() - start) / 1000;
            speed.textContent = `${formatBytes(offset / Math.max(seconds, 0.001))}/s · ${formatBytes(offset)} of ${formatBytes(file.size)}`;
          }
          const completed = await fetch(`/api/transfers/${session.id}/complete`, { method: "POST", headers, credentials: "same-origin", body: JSON.stringify({}) });
          if (!completed.ok) throw new Error(await responseError(completed));
          localStorage.removeItem(resumeKey);
          resolve();
        })().catch(reject);
      });
    }
    name.textContent = `Completed ${files.length - skippedFiles}; skipped ${skippedFiles}`; percent.textContent = "100%"; bar.style.width = "100%";
    document.querySelector(".running-indicator")?.classList.add("complete");
    setConnectionState("Last transfer completed", "online"); showNotice(`Sent ${files.length - skippedFiles}; skipped ${skippedFiles} to ${document.getElementById("destinationName").textContent}.`, "success"); fetchDirectory(currentPath); refreshDevices();
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
refreshNetworkInfo();
setInterval(refreshDevices, 5000);
setInterval(refreshNetworkInfo, 30000);
