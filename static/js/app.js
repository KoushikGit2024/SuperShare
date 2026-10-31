let currentPath = "";
let currentItems = [];
let selectedItems = new Map();
let currentHostBrowsePath = "";
const deviceIdKey = "supershare-device-id";
let localDeviceId = localStorage.getItem(deviceIdKey);
if (!localDeviceId) {
  localDeviceId = crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  localStorage.setItem(deviceIdKey, localDeviceId);
}
const clientPlatform = navigator.userAgentData?.platform || (/Android/i.test(navigator.userAgent) ? "Android" : /iPhone|iPad/i.test(navigator.userAgent) ? "iOS" : /Win/i.test(navigator.platform) ? "Windows" : /Mac/i.test(navigator.platform) ? "macOS" : "Browser");
const browserName = /EdgA?\//.test(navigator.userAgent) || /EdgiOS\//.test(navigator.userAgent) ? "Edge" : /OPR\//.test(navigator.userAgent) ? "Opera" : /FxiOS\//.test(navigator.userAgent) || /Firefox\//.test(navigator.userAgent) ? "Firefox" : /CriOS\//.test(navigator.userAgent) || /Chrome\//.test(navigator.userAgent) ? "Chrome" : /Safari\//.test(navigator.userAgent) ? "Safari" : "Web browser";
let localDeviceName = localStorage.getItem("supershare-device-name") || `${clientPlatform} · ${browserName}`;
document.getElementById("sourceDeviceName").textContent = localDeviceName;
document.getElementById("sourceProfileId").textContent = `Profile ID · ${localDeviceId.slice(0, 8)}`;
const localDeviceType = `${clientPlatform} browser · ${browserName}`;

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

function actionDialog({ title, message, inputLabel = "", inputValue = "", actions = [] }) {
  const dialog = document.getElementById("actionDialog");
  if (!dialog?.showModal) {
    showNotice("This browser does not support the accessible action dialog. Update the browser and try again.", "error");
    return Promise.resolve(null);
  }
  document.getElementById("actionDialogTitle").textContent = title;
  document.getElementById("actionDialogMessage").textContent = message;
  const inputWrap = document.getElementById("actionDialogInputWrap");
  const input = document.getElementById("actionDialogInput");
  inputWrap.classList.toggle("hidden", !inputLabel);
  document.getElementById("actionDialogInputLabel").textContent = inputLabel;
  input.value = inputValue;
  const actionList = document.getElementById("actionDialogActions");
  actionList.replaceChildren();
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onClose = () => { if (!settled) { settled = true; resolve(null); } };
    dialog.addEventListener("close", onClose, { once: true });
    const form = dialog.querySelector("form");
    form.onsubmit = event => event.preventDefault();
    input.onkeydown = event => {
      if (event.key === "Enter" && inputLabel) { event.preventDefault(); actionList.querySelector("button:last-child")?.click(); }
    };
    actions.forEach(action => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action.danger ? "btn-sm danger" : action.primary ? "btn-sm accent" : "btn-sm outline";
      button.textContent = action.label;
      button.addEventListener("click", () => finish(action.cancel ? null : inputLabel ? input.value.trim() || null : action.value));
      actionList.appendChild(button);
    });
    dialog.showModal();
    (inputLabel ? input : actionList.querySelector("button:last-child"))?.focus();
  });
}

function confirmAction(title, message, danger = false) {
  return actionDialog({ title, message, actions: [
    { label: "Keep current", value: false },
    { label: "Continue", value: true, primary: !danger, danger }
  ] });
}

function editText(title, message, label, value = "") {
  return actionDialog({ title, message, inputLabel: label, inputValue: value, actions: [
    { label: "Cancel", value: null, cancel: true }, { label: "Save", value: true, primary: true }
  ] });
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
      ? `HTTPS enabled · CA SHA-256: ${info.ca_fingerprint || "fingerprint unavailable"}. Trust the local CA in each browser before connecting.`
      : "HTTP mode · pairing codes and file data are unencrypted on the local network. Use only a trusted private hotspot or restart with --https.";
    let extra = "";
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
      const diagnosticResponse = await fetch("/api/diagnostics", { cache: "no-store" });
      if (diagnosticResponse.ok) {
        const diagnostic = await diagnosticResponse.json();
        extra = diagnostic.storage?.available_bytes != null
          ? ` · ${formatBytes(diagnostic.storage.available_bytes)} free on receive drive${diagnostic.storage.reserved_bytes ? ` · ${formatBytes(diagnostic.storage.reserved_bytes)} reserved for active transfers` : ""}`
          : "";
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
  window._profilePaired = Boolean(result.paired);
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
  const code = pairingCodeFromQr || await editText("Pair this browser profile", "Enter the code shown in the SuperShare laptop terminal. Compare the verification phrase before approving access.", "Session pairing code");
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
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...deviceHeaders() }, credentials: "same-origin", body: JSON.stringify(body) });
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
    document.getElementById("deviceCount").textContent = `${devices.length} profile${devices.length === 1 ? "" : "s"}`;
    const list = document.getElementById("deviceList");
    list.replaceChildren();
    if (!devices.length) {
      const empty = document.createElement("li"); empty.className = "empty-state";
      empty.textContent = data.host_dashboard ? "Waiting for browser profiles to connect…" : "Browser profile status and approvals are managed from the laptop dashboard.";
      list.appendChild(empty);
    }
    devices.forEach(device => {
      const li = document.createElement("li"); li.className = "device-row";
      const main = document.createElement("div"); main.className = "device-main";
      const avatar = document.createElement("span"); avatar.className = "device-avatar";
      avatar.appendChild(icon(/Android|iOS|iPhone|iPad/i.test(device.type) ? "device-mobile" : "monitor"));
      const info = document.createElement("div"); info.className = "device-info";
      const title = document.createElement("strong"); title.textContent = device.name + (device.id === localDeviceId ? " (this device)" : "");
      const phraseText = device.paired && !device.pair_confirmed && device.verification_phrase ? ` · Verify phrase: ${device.verification_phrase}` : "";
      const seenAt = new Date(device.last_seen * 1000);
      const elapsed = Math.max(0, Math.floor(Date.now() / 1000 - device.last_seen));
      const seenText = elapsed < 60 ? `${elapsed}s ago` : elapsed < 3600 ? `${Math.floor(elapsed / 60)}m ago` : seenAt.toLocaleString();
      const meta = document.createElement("span"); meta.textContent = `${device.type} · ${device.ip || "local network"} · last seen ${seenText}${phraseText}`;
      const identity = document.createElement("code"); identity.className = "device-identity"; identity.textContent = `Browser profile ID · ${String(device.id).slice(0, 8)}`;
      identity.title = String(device.id);
      const approval = document.createElement("span");
      approval.textContent = device.trusted ? "Persistent trust" : device.approved_until ? `Temporary approval until ${new Date(device.approved_until * 1000).toLocaleString()}` : "No active approval";
      info.append(title, meta, identity, approval); main.append(avatar, info);
      const isThisProfile = device.id === localDeviceId;
      const paired = Boolean(device.paired || isThisProfile);
      const phraseConfirmed = Boolean(device.pair_confirmed || isThisProfile);
      const accessActive = Boolean(isThisProfile || device.trusted || (device.approved_until || 0) > Math.floor(Date.now() / 1000));
      const effectivePermissions = isThisProfile ? { read: true, write: true } : device.permissions;
      const hasPermission = Boolean(effectivePermissions?.read || effectivePermissions?.write);
      const pending = paired && !(phraseConfirmed && accessActive && hasPermission);
      const state = document.createElement("span"); state.className = `device-state ${!paired || pending ? "pending" : device.online ? "online" : "offline"}`;
      if (!paired) state.append(icon("pending"), document.createTextNode(" Pairing incomplete"));
      else if (!phraseConfirmed) state.append(icon("pending"), document.createTextNode(" Verify phrase"));
      else if (pending) state.append(icon("pending"), document.createTextNode(" Needs approval"));
      else {
        const permissionText = `${effectivePermissions?.read ? "Read" : ""}${effectivePermissions?.read && effectivePermissions?.write ? " + " : ""}${effectivePermissions?.write ? "Send" : ""}`;
        const accessText = device.trusted ? "Trusted" : (device.approved_until || 0) > Math.floor(Date.now() / 1000) ? `Temporary · expires ${new Date(device.approved_until * 1000).toLocaleTimeString()}` : "No active approval";
        state.textContent = `${device.online ? "Online" : "Offline"} · ${accessText} · ${permissionText}`;
      }
      li.append(main, state);
      {
        const controls = document.createElement("div"); controls.className = "device-controls";
        const rename = document.createElement("button"); rename.className = "btn-xs outline"; rename.textContent = "Rename";
        rename.onclick = async () => {
          const name = await editText("Name browser profile", `This label helps distinguish this browser profile. It does not verify the physical device.\n\nProfile ID: ${device.id}`, "Display name", device.name);
          if (!name) return;
          const ok = await deviceAction("/api/devices/rename", { id: device.id, name });
          if (ok) refreshDevices();
        };
        controls.appendChild(rename);
        if (device.id !== localDeviceId) {
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
          revoke.onclick = async () => { if (await confirmAction("Revoke browser access?", `This invalidates ${device.name}'s saved pairing credential and cancels its active uploads. The browser must pair again before it can be approved.`, true) && await deviceAction("/api/devices/revoke", { id: device.id })) refreshDevices(); };
          controls.appendChild(revoke);
        }
        const forget = document.createElement("button"); forget.className = "btn-xs outline"; forget.textContent = "Forget";
        forget.onclick = async () => { if (await confirmAction("Forget this browser profile?", `${device.name}'s saved identity and access record will be removed from this host. It must pair again to reconnect.`, true) && await deviceAction("/api/devices/forget", { id: device.id })) refreshDevices(); };
        controls.appendChild(forget);
        }
        li.append(controls);
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
document.getElementById("nameBrowserBtn").addEventListener("click", async () => {
  const name = await editText("Name this browser profile", "This label helps the laptop identify this browser profile. It does not prove physical device identity.", "Display name", localDeviceName);
  if (!name) return;
  localDeviceName = name;
  localStorage.setItem("supershare-device-name", name);
  document.getElementById("sourceDeviceName").textContent = name;
  if (window._profilePaired) await deviceAction("/api/devices/rename", { id: localDeviceId, name });
  else showNotice("Profile name saved in this browser. It will be shared with the host when you pair.", "success");
  refreshDevices();
});

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
    const status = document.createElement("span"); status.className = `transfer-state ${t.status}`;
    status.textContent = ({ queued: "Queued", transferring: "Transferring", verifying: "Verifying", interrupted: "Interrupted · can resume", completed: "Completed", failed: "Failed", cancelled: "Cancelled", skipped: "Skipped" })[t.status] || t.status;
    li.append(name, detail, status);
    if (t.size > 0 && t.offset != null && ["queued", "transferring", "interrupted", "verifying"].includes(t.status)) {
      const progress = document.createElement("progress");
      progress.className = "transfer-progress";
      progress.max = t.size;
      progress.value = Math.min(t.offset, t.size);
      progress.setAttribute("aria-label", `${t.filename}: ${Math.round(t.offset / t.size * 100)} percent, ${formatBytes(t.offset)} of ${formatBytes(t.size)} acknowledged by host`);
      li.appendChild(progress);
    }
    if (["queued", "transferring", "interrupted", "verifying"].includes(t.status)) {
      const cancel = document.createElement("button"); cancel.className = "btn-xs outline"; cancel.textContent = t.status === "verifying" ? "Stop verification" : "Cancel";
      cancel.onclick = async () => {
        if (!await confirmAction("Cancel this transfer?", `Cancel ${t.filename} and remove its partial file from the host?`, true)) return;
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

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const remaining = total % 60;
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${remaining}s` : `${remaining}s`;
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
  try { const response = await fetch("/api/pick-host-gui", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); if (!response.ok) throw new Error(await responseError(response)); await fetchDirectory(""); }
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
  if (!await confirmAction("Delete selected items?", `This permanently removes ${selectedItems.size} item(s) from the host shared folder.`, true)) return;
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
  const queue = document.getElementById("uploadQueue");
  box.classList.remove("hidden");
  document.querySelector(".running-indicator")?.classList.remove("complete", "failed");
  let skippedFiles = 0;
  try {
    const access = await checkUploadPermission();
    if (!access.canSend) throw new Error("The host has not enabled send access for this device.");
  } catch (error) { showNotice(error.message, "error"); return; }
    setConnectionState(`Sending ${files.length} file${files.length === 1 ? "" : "s"}`, "online");
  queue.replaceChildren();
  queue.classList.remove("hidden");
  const queueEntries = Array.from(files, (file, index) => {
    const relative = retryName || file.webkitRelativePath || file.name;
    const row = document.createElement("li");
    const fileName = document.createElement("span"); fileName.className = "upload-queue-name"; fileName.textContent = `${index + 1}. ${relative} · ${formatBytes(file.size)}`;
    const state = document.createElement("span"); state.className = "upload-queue-state"; state.textContent = "Queued"; state.setAttribute("aria-live", "polite");
    const progress = document.createElement("progress"); progress.max = file.size || 1; progress.value = 0; progress.setAttribute("aria-label", `${relative}: queued`);
    row.append(fileName, state, progress); queue.appendChild(row);
    return { state, progress, relative };
  });
  let activeQueueEntry = null;
  try {
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const relative = retryName || file.webkitRelativePath || file.name;
      const destination = currentPath ? `${currentPath}/${relative}` : relative;
      const queueEntry = queueEntries[index];
      activeQueueEntry = queueEntry;
      queueEntry.state.textContent = "Preparing"; queueEntry.state.className = "upload-queue-state running";
      name.textContent = `Uploading ${index + 1} of ${files.length}: ${relative}`;
      bar.style.width = "0%"; percent.textContent = "0%"; speed.textContent = "Starting";
      await new Promise((resolve, reject) => {
        (async () => {
          const start = Date.now();
          let lastSampleAt = start;
          let lastSampleOffset = 0;
          const headers = { "Content-Type": "application/json", ...deviceHeaders() };
          const resumeKey = `supershare-transfer:${localDeviceId}:${destination}:${file.name}:${file.size}:${file.lastModified}`;
          const resumeId = localStorage.getItem(resumeKey) || "";
          let collision = "ask";
          let created = await fetch("/api/transfers", { method: "POST", headers, credentials: "same-origin", body: JSON.stringify({ name: file.name, size: file.size, path: destination, resume_id: resumeId, collision }) });
          if (created.status === 409) {
            collision = await actionDialog({ title: "Destination file already exists", message: `${destination}\n\nChoose how to handle the existing file. Replacing publishes the incoming file only after its chunks verify.`, actions: [
              { label: "Cancel", value: "cancel" }, { label: "Skip", value: "skip" },
              { label: "Keep both", value: "rename" }, { label: "Replace after verify", value: "replace", primary: true }
            ] }) || "cancel";
            if (collision === "cancel") { skippedFiles++; queueEntry.state.textContent = "Cancelled"; queueEntry.state.className = "upload-queue-state"; resolve(); return; }
            created = await fetch("/api/transfers", { method: "POST", headers, credentials: "same-origin", body: JSON.stringify({ name: file.name, size: file.size, path: destination, collision }) });
          }
          if (!created.ok) throw new Error(await responseError(created));
          const session = await created.json();
          if (session.status === "skipped") { skippedFiles++; queueEntry.state.textContent = "Skipped"; queueEntry.state.className = "upload-queue-state"; resolve(); return; }
          if (session.status === "completed") { localStorage.removeItem(resumeKey); queueEntry.state.textContent = "Completed"; queueEntry.state.className = "upload-queue-state complete"; queueEntry.progress.value = queueEntry.progress.max; resolve(); return; }
          localStorage.setItem(resumeKey, session.id);
          let offset = session.offset || 0;
          const resumeOffset = offset;
          lastSampleOffset = offset;
          const chunkSize = session.chunk_size;
          queueEntry.progress.value = Math.min(offset, file.size || 1);
          queueEntry.progress.setAttribute("aria-label", `${relative}: resumed at ${formatBytes(offset)} of ${formatBytes(file.size)}`);
          queueEntry.state.textContent = "Transferring";
          while (offset < file.size) {
            const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size));
            const chunkChecksum = await sha256Blob(chunk);
            const response = await fetch(`/api/transfers/${session.id}/chunk`, { method: "PUT", headers: { ...deviceHeaders(), "X-Chunk-Offset": String(offset), "X-Chunk-SHA256": chunkChecksum }, credentials: "same-origin", body: chunk });
            if (!response.ok) throw new Error(await responseError(response));
            const result = await response.json(); offset = result.offset;
            queueEntry.progress.value = Math.min(offset, file.size || 1);
            queueEntry.progress.setAttribute("aria-label", `${relative}: ${Math.round(file.size ? offset / file.size * 100 : 100)} percent, ${formatBytes(offset)} of ${formatBytes(file.size)} acknowledged`);
            const progress = file.size ? Math.round(offset / file.size * 100) : 100;
            bar.style.width = `${progress}%`; percent.textContent = `${progress}%`;
            const now = Date.now();
            const elapsedSeconds = Math.max((now - start) / 1000, 0.001);
            const sampleSeconds = Math.max((now - lastSampleAt) / 1000, 0.001);
            const currentRate = Math.max(offset - lastSampleOffset, 0) / sampleSeconds;
            const averageRate = (offset - resumeOffset) / elapsedSeconds;
            const remainingSeconds = averageRate > 0 ? Math.ceil((file.size - offset) / averageRate) : 0;
            speed.textContent = `${formatBytes(currentRate)}/s recent · ${formatBytes(averageRate)}/s avg · ${formatDuration(elapsedSeconds)} elapsed${remainingSeconds ? ` · about ${formatDuration(remainingSeconds)} left` : ""}`;
            lastSampleAt = now; lastSampleOffset = offset;
          }
          name.textContent = `Verifying ${file.name}`;
          queueEntry.state.textContent = "Verifying";
          speed.textContent = "Verifying chunks and final file checksum";
          const completed = await fetch(`/api/transfers/${session.id}/complete`, { method: "POST", headers, credentials: "same-origin", body: JSON.stringify({}) });
          if (!completed.ok) throw new Error(await responseError(completed));
          localStorage.removeItem(resumeKey);
          queueEntry.state.textContent = "Completed"; queueEntry.state.className = "upload-queue-state complete"; queueEntry.progress.value = queueEntry.progress.max;
          resolve();
        })().catch(reject);
      });
    }
    name.textContent = `Completed ${files.length - skippedFiles}; skipped ${skippedFiles}`; percent.textContent = "100%"; bar.style.width = "100%";
    document.querySelector(".running-indicator")?.classList.add("complete");
    setConnectionState("Last transfer completed", "online"); showNotice(`Sent ${files.length - skippedFiles}; skipped ${skippedFiles} to ${document.getElementById("destinationName").textContent}.`, "success"); fetchDirectory(currentPath); refreshDevices();
  } catch (error) {
    name.textContent = "Transfer failed";
    if (activeQueueEntry) { activeQueueEntry.state.textContent = `Failed · ${error.message}`; activeQueueEntry.state.className = "upload-queue-state failed"; }
    queueEntries.forEach(entry => { if (entry.state.textContent === "Queued") entry.state.textContent = "Not started · earlier file failed"; });
    document.querySelector(".running-indicator")?.classList.add("failed");
    setConnectionState("Transfer failed", "error"); showNotice(error.message, "error"); refreshDevices();
  }
}

document.getElementById("fileInput").onchange = event => { const files = Array.from(event.target.files || []); event.target.value = ""; uploadFiles(files); };
document.getElementById("folderInput").onchange = event => { const files = Array.from(event.target.files || []); event.target.value = ""; uploadFiles(files); };
const dropZone = document.getElementById("dropZone");
dropZone.addEventListener("dragover", event => { event.preventDefault(); dropZone.classList.add("drag-active"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-active"));
dropZone.addEventListener("drop", event => { event.preventDefault(); dropZone.classList.remove("drag-active"); uploadFiles(event.dataTransfer.files); });
document.addEventListener("paste", event => { const files = Array.from(event.clipboardData?.files || []); if (files.length) uploadFiles(files); });
document.getElementById("newFolderBtn").onclick = async () => {
  const name = await editText("Create a folder", "The folder will be created inside the current shared location.", "Folder name"); if (!name) return;
  const path = currentPath ? `${currentPath}/${name}` : name;
  const response = await fetch("/api/mkdir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
  if (response.ok) fetchDirectory(currentPath); else showNotice(await responseError(response), "error");
};

fetchDirectory().catch(showDirectoryError);
refreshDevices();
refreshNetworkInfo();
setInterval(refreshDevices, 5000);
setInterval(refreshNetworkInfo, 30000);
