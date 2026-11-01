async function waitForHost(signal) {
  for (let i = 0; ; i++) {
    signal?.throwIfAborted();
    const probe = new AbortController();
    const timer = setTimeout(() => probe.abort(), 4000);
    const relay = () => probe.abort();
    signal?.addEventListener("abort", relay, { once: true });
    try {
      if ((await fetch("/api/network", { cache: "no-store", signal: probe.signal })).ok) return;
    } catch (_) {
      // Host still unreachable
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", relay);
    }
    await sleep(Math.min(5000, 500 * 2 ** i), signal);
  }
}

async function postCreate(body, headers, signal, onWait) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch("/api/transfers", {
        method: "POST", headers, credentials: "same-origin", signal, body: JSON.stringify(body)
      });
      if (r.status !== 429 || i >= 60) return r;
      onWait("Waiting for a free transfer slot on the laptop…");
      const retrySec = Number(r.headers.get("Retry-After")) || 3;
      await sleep(retrySec * 1000, signal);
    } catch (e) {
      if (e.name === "AbortError" || !(e instanceof TypeError) || i >= 60) throw e;
      onWait("Connection lost. Waiting for the laptop…");
      await waitForHost(signal);
    }
  }
}

async function finishTransfer(session, headers, signal, onProgress = () => {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(`/api/transfers/${session.id}/complete`, {
        method: "POST", headers, credentials: "same-origin", signal, body: "{}"
      });
      if (r.status === 202) {
        // Verification ongoing: poll status for progress feedback (UI/UX 22)
        try {
          const stRes = await fetch(`/api/transfers/${session.id}`, { headers: deviceHeaders(), signal });
          if (stRes.ok) {
            const stData = await stRes.json();
            if (stData.verified) onProgress(stData.verified, stData.size);
          }
        } catch (_) {}
        await sleep(2000, signal);
        continue;
      }
      if (r.status === 409) {
        const info = await r.clone().json().catch(() => null);
        if (info?.error === "chunks_corrupt") return info;
      }
      if (!r.ok) throw Object.assign(new Error(await responseError(r)), { status: r.status });
      return r.json();
    } catch (e) {
      if (e.name === "AbortError" || !(e instanceof TypeError) || attempt >= 30) throw e;
      await waitForHost(signal);
    }
  }
}

let activeUpload = { id: null, resumeKey: null };

function cancelActiveSession() {
  const { id, resumeKey } = activeUpload;
  if (!id) return;
  safeStorage.removeItem(resumeKey);
  fetch(`/api/transfers/${id}/cancel`, {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: deviceHeaders()
  }).catch(() => {});
  activeUpload = { id: null, resumeKey: null };
}

const relPath = file => file._relativePath || file.webkitRelativePath || file.name;

async function filesFromDataTransfer(dt) {
  if (!dt) return [];
  const entries = Array.from(dt.items || []).filter(i => i.kind === "file")
    .map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return Array.from(dt.files || []);
  const out = [];
  const readAll = reader => new Promise((resolve, reject) => {
    const all = [];
    const next = () => reader.readEntries(batch => batch.length ? (all.push(...batch), next()) : resolve(all), reject);
    next();
  });
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      Object.defineProperty(file, "_relativePath", { value: prefix + entry.name });
      out.push(file);
    } else if (entry.isDirectory) {
      for (const child of await readAll(entry.createReader())) {
        await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const entry of entries) {
    await walk(entry, "");
  }
  return out;
}

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("Aborted", "AbortError")); }, { once: true });
});

const backoff = n => Math.min(30000, 1000 * 2 ** n) * (0.5 + Math.random() / 2);

const waitOnline = signal => navigator.onLine ? Promise.resolve() : new Promise((res, rej) => {
  addEventListener("online", res, { once: true });
  signal?.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")), { once: true });
});

const isRetryable = e => e.network || [408, 422, 425, 429, 500, 502, 503, 504].includes(e.status);

function putChunk(url, body, headers, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.withCredentials = true;
    xhr.timeout = 120000;
    for (const [k, v] of Object.entries(headers)) {
      xhr.setRequestHeader(k, v);
    }
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded);
    xhr.onload = () => xhr.status < 300 ? resolve()
      : reject(Object.assign(new Error(xhr.responseText || `HTTP ${xhr.status}`), { status: xhr.status }));
    xhr.onerror = () => reject(Object.assign(new Error("Lost connection to the laptop"), { network: true }));
    xhr.ontimeout = () => reject(Object.assign(new Error("Chunk upload timed out"), { network: true }));
    const abort = () => { xhr.abort(); reject(new DOMException("Aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    xhr.send(body);
  });
}

async function sendChunks({ session, file, offsets, chunkSize, signal, onBytes, onStatus = () => {} }) {
  const inner = new AbortController();
  signal.addEventListener("abort", () => inner.abort(), { once: true });
  let cursor = 0;
  const worker = async () => {
    try {
      while (cursor < offsets.length) {
        inner.signal.throwIfAborted();
        const off = offsets[cursor++];
        const buf = await file.slice(off, Math.min(off + chunkSize, file.size)).arrayBuffer();
        const hash = await sha256Buf(buf);
        let sent = 0;
        for (let failures = 0; ; ) {
          try {
            await putChunk(`/api/transfers/${session.id}/chunk`, buf,
              { ...deviceHeaders(), "X-Chunk-Offset": String(off), "X-Chunk-SHA256": hash },
              inner.signal, loaded => { onBytes(loaded - sent); sent = loaded; });
            onBytes(buf.byteLength - sent);
            break;
          } catch (e) {
            onBytes(-sent);
            sent = 0;
            if (e.name === "AbortError" || !isRetryable(e) || ++failures > (e.network ? 60 : 8)) throw e;
            if (e.network) {
              onStatus("Connection lost. Waiting for the laptop…");
              await waitForHost(inner.signal);
            } else {
              await sleep(backoff(failures), inner.signal);
            }
          }
        }
      }
    } catch (e) {
      inner.abort();
      throw e;
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, Math.max(1, offsets.length)) }, worker));
}

function friendlyError(e) {
  if (e.name === "AbortError") return "Cancelled";
  if (e.network || e instanceof TypeError) return "Lost connection to the laptop. Check both devices are on the same hotspot and mobile data isn't taking over, then select the file again to resume.";
  if (["NotReadableError", "NotFoundError"].includes(e.name)) return "The browser can no longer read this file (moved, deleted or permission revoked).";
  if (e.status === 507) return "The laptop's receive drive is full.";
  if (e.status === 429) return "The host is already running its maximum number of transfers. Wait or cancel a stalled one.";
  if (e.status === 403) return "The host has not granted this browser send access.";
  if (e.status === 409) return `The host stopped this transfer: ${e.message}`;
  return e.message || "Unknown error";
}

function listBusy(list) {
  return Boolean(list && (list.contains(document.activeElement) || list.querySelector("details[open]")));
}

let currentPath = "";
let currentItems = [];
let selectedItems = new Map();
let currentHostBrowsePath = "";

const safeStorage = {
  getItem(k) { try { return localStorage.getItem(k); } catch (_) { return this[k] || null; } },
  setItem(k, v) { try { localStorage.setItem(k, v); } catch (_) { this[k] = String(v); } },
  removeItem(k) { try { localStorage.removeItem(k); } catch (_) { delete this[k]; } }
};

const deviceIdKey = "supershare-device-id";
let localDeviceId = safeStorage.getItem(deviceIdKey);
if (!localDeviceId) {
  localDeviceId = crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  safeStorage.setItem(deviceIdKey, localDeviceId);
}

// Purge supershare-transfer resume keys older than 7 days (L4)
try {
  const now = Date.now();
  const cutoff = 7 * 24 * 3600 * 1000;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith("supershare-transfer-time:")) {
      const ts = Number(localStorage.getItem(k)) || 0;
      if (now - ts > cutoff) {
        const transferKey = k.replace("-time:", ":");
        localStorage.removeItem(transferKey);
        localStorage.removeItem(k);
      }
    }
  }
} catch (_) {}
const clientPlatform = navigator.userAgentData?.platform || (/Android/i.test(navigator.userAgent) ? "Android" : /iPhone|iPad/i.test(navigator.userAgent) ? "iOS" : /Win/i.test(navigator.platform) ? "Windows" : /Mac/i.test(navigator.platform) ? "macOS" : "Browser");
const browserName = /EdgA?\//.test(navigator.userAgent) || /EdgiOS\//.test(navigator.userAgent) ? "Edge" : /OPR\//.test(navigator.userAgent) ? "Opera" : /FxiOS\//.test(navigator.userAgent) || /Firefox\//.test(navigator.userAgent) ? "Firefox" : /CriOS\//.test(navigator.userAgent) || /Chrome\//.test(navigator.userAgent) ? "Chrome" : /Safari\//.test(navigator.userAgent) ? "Safari" : "Web browser";
function wellFormedText(value) {
  const text = String(value ?? "");
  let result = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) result += text[index] + text[++index];
      else result += "\uFFFD";
    } else if (code >= 0xDC00 && code <= 0xDFFF) result += "\uFFFD";
    else result += text[index];
  }
  return result;
}
let localDeviceName = wellFormedText(safeStorage.getItem("supershare-device-name")) || `${clientPlatform} · ${browserName}`;
document.getElementById("sourceDeviceName").textContent = localDeviceName;
document.getElementById("sourceProfileId").textContent = `Profile ID · ${localDeviceId.slice(0, 8)}`;
const localDeviceType = `${clientPlatform} browser · ${browserName}`;

function deviceHeaders() {
  return { "X-SuperShare-Device": localDeviceId, "X-SuperShare-Name": encodeURIComponent(localDeviceName), "X-SuperShare-Type": encodeURIComponent(localDeviceType) };
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
let pairingCodeFromQr = new URLSearchParams(location.search).get("pair_code");
async function refreshNetworkInfo() {
  const addresses = document.getElementById("networkAddresses");
  const status = document.getElementById("networkStatus");
  try {
    const response = await fetch("/api/network", { cache: "no-store" });
    if (!response.ok) throw new Error(await responseError(response));
    const info = await response.json();
    addresses.replaceChildren();
    const connection = info.connection || null;
    const nextConnectionUrl = connection?.url || "";
    if (preferredConnectionUrl && preferredConnectionUrl !== nextConnectionUrl) {
      document.getElementById("pairQrPanel").classList.add("hidden");
      const qrToggle = document.getElementById("showPairQrBtn");
      qrToggle.setAttribute("aria-expanded", "false"); qrToggle.textContent = "Show pairing QR";
      const qrImage = document.getElementById("pairQrImage");
      if (qrImage.dataset.objectUrl) { URL.revokeObjectURL(qrImage.dataset.objectUrl); delete qrImage.dataset.objectUrl; }
    }
    preferredConnectionUrl = nextConnectionUrl;
    const copyButton = document.getElementById("copyConnectionBtn");
    const qrButton = document.getElementById("showPairQrBtn");
    copyButton.disabled = !preferredConnectionUrl;
    qrButton.disabled = !preferredConnectionUrl;
    if (connection) {
      const card = document.createElement("div"); card.className = "hotspot-address-card";
      const label = document.createElement("span"); label.className = "hotspot-kind"; label.textContent = connection.kind || "Wi-Fi / hotspot";
      const url = document.createElement("code"); url.textContent = connection.url;
      const adapter = document.createElement("span"); adapter.className = "hotspot-adapter"; adapter.textContent = `Using ${connection.name} · ${connection.address}`;
      const routeHint = document.createElement("span"); routeHint.className = "hotspot-adapter";
      routeHint.textContent = connection.kind === "Windows hotspot"
        ? "Use this when the phone is connected to this laptop’s Windows Mobile Hotspot."
        : "Use this when this laptop is connected to the phone’s hotspot or the same Wi-Fi as the phone.";
      card.append(label, url, adapter, routeHint); addresses.appendChild(card);
    } else {
      const empty = document.createElement("p"); empty.className = "no-hotspot";
      empty.textContent = "No Wi-Fi or hotspot address was detected. Turn on the laptop hotspot, connect this laptop to Wi-Fi, then refresh.";
      addresses.appendChild(empty);
    }
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
    status.textContent = connection
      ? `${connection.kind} ready · Pairing required · Internet not required${extra}`
      : `SuperShare is running on this laptop, but no Wi-Fi / hotspot address is available${extra}`;
    status.classList.remove("error");
    status.classList.toggle("attention", !connection);
  } catch (error) {
    status.textContent = `Connection diagnostics unavailable: ${error.message}`;
    status.classList.remove("attention"); status.classList.add("error");
  }
}

document.getElementById("copyConnectionBtn").addEventListener("click", async () => {
  try {
    if (!preferredConnectionUrl) await refreshNetworkInfo();
    if (!preferredConnectionUrl) throw new Error("Turn on the laptop hotspot or connect this laptop to Wi-Fi first.");
    await navigator.clipboard.writeText(preferredConnectionUrl);
    showNotice("Connection address copied. Open it on a device connected to this hotspot.", "success");
  } catch (_) { showNotice("Could not copy the connection address. Select and copy it from the Network section.", "error"); }
});

document.getElementById("showPairQrBtn").addEventListener("click", async () => {
  try {
    const panel = document.getElementById("pairQrPanel");
    const toggle = document.getElementById("showPairQrBtn");
    if (!panel.classList.contains("hidden")) {
      panel.classList.add("hidden"); toggle.setAttribute("aria-expanded", "false"); toggle.textContent = "Show pairing QR";
      return;
    }
    if (!preferredConnectionUrl) throw new Error("No hotspot address is available yet. Turn on the hotspot and refresh.");
    const response = await fetch("/api/pairing-qr", { cache: "no-store" });
    if (!response.ok) throw new Error(await responseError(response));
    const image = document.getElementById("pairQrImage");
    if (image.dataset.objectUrl) URL.revokeObjectURL(image.dataset.objectUrl);
    image.dataset.objectUrl = URL.createObjectURL(await response.blob());
    image.src = image.dataset.objectUrl;
    document.getElementById("pairingUrlText").textContent = response.headers.get("X-SuperShare-Pairing-URL") || preferredConnectionUrl;
    panel.classList.remove("hidden");
    toggle.setAttribute("aria-expanded", "true"); toggle.textContent = "Hide pairing QR";
  } catch (error) { showNotice(error.message, "error"); }
});

document.getElementById("hidePairQrBtn").addEventListener("click", () => {
  document.getElementById("pairQrPanel").classList.add("hidden");
  const toggle = document.getElementById("showPairQrBtn"); toggle.setAttribute("aria-expanded", "false"); toggle.textContent = "Show pairing QR";
});

document.getElementById("copyPairingUrlBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(document.getElementById("pairingUrlText").textContent);
    showNotice("Pairing link copied. Open it on a device connected to this hotspot.", "success");
  } catch (_) { showNotice("Could not copy the pairing link.", "error"); }
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
  if (!uploadInProgress) setConnectionState(result.allowed ? "Approved to send" : canRead ? "Host granted read-only access" : result.approved ? "Host granted send-only access" : result.paired ? "Waiting for host approval" : "Pair with the host", result.allowed || canRead ? "online" : "pending");
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
    if (!response.ok) {
      if (response.status === 403 && pairingCodeFromQr) {
        pairingCodeFromQr = null;
        history.replaceState({}, "", location.pathname);
        throw new Error("That pairing link has expired (the host restarted?). Tap Pair with host and enter the current code.");
      }
      throw new Error(await responseError(response));
    }
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
    document.getElementById("deleteSelectedBtn")?.classList.toggle("hidden", !data.host_dashboard);
    document.getElementById("quickQrBtn")?.classList.toggle("hidden", !data.host_dashboard);
    document.getElementById("tab-storage-mgr")?.classList.toggle("hidden", !data.host_dashboard);
    if (!data.host_dashboard && activeTabId === "storageMgrSection") switchTab("sendSection");
    document.getElementById("destinationName").textContent = data.host_name || "This host";
    window._shareRoot = data.share_root || "";
    document.getElementById("destinationPath").textContent = data.share_root ? `${data.share_root}${currentPath ? `\\${currentPath.replaceAll("/", "\\")}` : ""}` : "Pair and get host approval to view the destination";
    const canUpload = await checkUploadPermission();
    const devices = data.devices || [];
    window._lastDevices = devices;
    document.getElementById("deviceCount").textContent = `${devices.length} profile${devices.length === 1 ? "" : "s"}`;
    const list = document.getElementById("deviceList");
    if (listBusy(list)) return;
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
      const perms = device.permissions || {};
      const live = device.trusted || (device.approved_until || 0) > Date.now() / 1000;
      const access = !device.paired ? "Not paired" : !device.pair_confirmed ? "Phrase not confirmed"
        : !live ? "Awaiting approval" : [perms.read && "Read", perms.write && "Send"].filter(Boolean).join(" + ") || "No access";
      const state = document.createElement("span"); 
      state.className = `device-state ${device.online ? "online" : "offline"}`;
      state.textContent = `${device.online ? "Online" : "Offline"} · ${access}`;
      li.append(main, state);
      {
        const controls = document.createElement("div"); controls.className = "device-controls";
        if (data.host_dashboard && device.id !== localDeviceId) {
          const mk = (label, fn, cls = "outline") => { const b = document.createElement("button"); b.className = `btn-xs ${cls}`; b.textContent = label; b.onclick = fn; return b; };
          const grant = remember => async () => { if (await deviceAction("/api/devices/approve", { id: device.id, permissions: { read: true, write: true }, remember })) refreshDevices(); };
          const ready = device.paired;
          if (device.paired && !device.pair_confirmed && device.verification_phrase) {
            const phraseCode = document.createElement("code");
            phraseCode.style.cssText = "display:block;width:100%;margin-bottom:6px;color:#fef08a;font-weight:bold;";
            phraseCode.textContent = `Compare phrase: ${device.verification_phrase}`;
            controls.appendChild(phraseCode);
          }
          const allow = mk("Allow 15 min", grant(false), "accent"); allow.disabled = !ready;
          const always = mk("Always allow", grant(true)); always.disabled = !ready;
          const revoke = mk("Revoke", async () => {
            if (await confirmAction("Revoke access?", `${device.name} loses access and its transfers are cancelled.`, true)
                && await deviceAction("/api/devices/revoke", { id: device.id })) refreshDevices(); });
          controls.prepend(allow, always, revoke);
        }
        const rename = document.createElement("button"); rename.className = "btn-xs outline"; rename.textContent = "Rename";
        rename.onclick = async () => {
          const name = await editText("Name device", `Give this device a recognizable name:`, "Display name", device.name);
          if (!name) return;
          const ok = await deviceAction("/api/devices/rename", { id: device.id, name });
          if (ok) refreshDevices();
        };
        controls.appendChild(rename);
        if (device.id !== localDeviceId) {
          const forget = document.createElement("button"); forget.className = "btn-xs outline"; forget.textContent = "Remove";
          forget.onclick = async () => { if (await confirmAction("Remove device?", `Remove ${device.name} from the devices list?`, true) && await deviceAction("/api/devices/forget", { id: device.id })) refreshDevices(); };
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
    if (typeof syncTabIndicators === "function") syncTabIndicators();
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
  localDeviceName = wellFormedText(name);
  safeStorage.setItem("supershare-device-name", localDeviceName);
  document.getElementById("sourceDeviceName").textContent = localDeviceName;
  if (window._profilePaired) await deviceAction("/api/devices/rename", { id: localDeviceId, name: localDeviceName });
  else showNotice("Profile name saved in this browser. It will be shared with the host when you pair.", "success");
  refreshDevices();
});

function renderTransfers(transfers) {
  const list = document.getElementById("transferList");
  if (listBusy(list)) return;
  list.replaceChildren();
  const filter = document.getElementById("transferFilter")?.value || "all";
  const activeStates = ["queued", "transferring", "interrupted", "verifying"];
  const filtered = [...transfers].filter(t => !String(t.device_id || "").startsWith("benchmark-"))
    .filter(t => filter === "all" || (filter === "active" ? activeStates.includes(t.status) : t.status === filter))
    .sort((a, b) => Number(activeStates.includes(b.status)) - Number(activeStates.includes(a.status))
      || (b.updated_at || b.timestamp || 0) - (a.updated_at || a.timestamp || 0));
  if (!filtered.length) { const empty = document.createElement("li"); empty.className = "empty-state"; empty.textContent = filter === "all" ? "No transfers yet." : `No ${filter} transfers.`; list.appendChild(empty); return; }
  filtered.forEach(t => {
    const li = document.createElement("li"); li.className = "transfer-row";
    const device = (window._lastDevices || []).find(item => item.id === t.device_id);
    const name = document.createElement("strong"); name.textContent = t.filename;
    const route = document.createElement("span"); route.className = "transfer-route";
    const from = t.direction === "send" ? "This laptop" : (device?.name || "Browser profile");
    const to = t.direction === "send" ? (device?.name || (t.destination === "local-dashboard" ? "This laptop browser" : "Connected browser")) : compactDestination(t.destination);
    route.textContent = t.direction === "send" ? `Downloaded on ${to}` : `Received from ${from} · saved to ${to}`;
    const status = document.createElement("span"); status.className = `transfer-state ${t.status}`;
    status.textContent = ({ queued: "Queued", transferring: "Transferring", verifying: "Verifying", interrupted: "Interrupted · can resume", completed: "Completed", failed: "Failed", cancelled: "Cancelled", skipped: "Skipped" })[t.status] || t.status;
    const top = document.createElement("div"); top.className = "transfer-topline"; top.append(name, status);
    const meta = document.createElement("span"); meta.className = "transfer-meta";
    meta.textContent = `${formatBytes(t.size || 0)} · ${new Date((t.timestamp || t.updated_at) * 1000).toLocaleString()}`;
    const body = document.createElement("div"); body.className = "transfer-body"; body.append(top, route, meta);
    if (t.size > 0 && t.offset != null && ["queued", "transferring", "interrupted", "verifying"].includes(t.status)) {
      const progress = document.createElement("progress");
      progress.className = "transfer-progress";
      progress.max = t.size;
      progress.value = Math.min(t.offset, t.size);
      progress.setAttribute("aria-label", `${t.filename}: ${Math.round(t.offset / t.size * 100)} percent, ${formatBytes(t.offset)} of ${formatBytes(t.size)} acknowledged by host`);
      body.appendChild(progress);
      const progressMeta = document.createElement("span"); progressMeta.className = "transfer-meta";
      progressMeta.textContent = `${formatBytes(t.offset)} of ${formatBytes(t.size)} received`;
      body.appendChild(progressMeta);
    }
    if (t.detail || t.destination || t.sha256) {
      const details = document.createElement("details"); details.className = "transfer-details";
      const summary = document.createElement("summary"); summary.textContent = "Transfer details";
      const extra = document.createElement("span");
      const fields = [];
      if (t.destination) fields.push(`Location: ${compactDestination(t.destination)}`);
      if (t.detail) fields.push(t.detail);
      if (t.sha256) fields.push(`SHA-256: ${t.sha256}`);
      extra.textContent = fields.join(" · "); details.append(summary, extra); body.appendChild(details);
    }
    li.appendChild(body);
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
        const targetPath = t.relative_path || t.filename;
        input.onchange = () => {
          if (input.files?.length === 1) uploadFiles(input.files, targetPath);
          else showNotice("Choose exactly the one file that failed.", "info");
        };
        input.click();
      };
      li.appendChild(retry);
    }
    list.appendChild(li);
  });
}

function compactDestination(destination) {
  const value = String(destination || "shared folder");
  const root = String(window._shareRoot || "").replace(/[\\/]+$/, "");
  if (root && value.toLowerCase().startsWith(root.toLowerCase())) {
    const relative = value.slice(root.length).replace(/^[\\/]+/, "");
    return relative ? `/${relative.replaceAll("\\", "/")}` : "Shared folder root";
  }
  if (value === "local-dashboard") return "This laptop browser";
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : normalized;
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

let hashWorkers = null, hashSeq = 0;
const hashPending = new Map();

function ensureHashWorkers() {
  if (hashWorkers) return hashWorkers;
  try {
    const source = `const SHA256_K = new Uint32Array([${Array.from(SHA256_K).join(",")}]);
      ${sha256Bytes.toString()}
      onmessage = e => postMessage({ id: e.data.id, hash: sha256Bytes(new Uint8Array(e.data.buf)) });`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    hashWorkers = Array.from({ length: Math.min(2, navigator.hardwareConcurrency || 2) }, () => {
      const w = new Worker(url);
      w.onmessage = ({ data }) => {
        hashPending.get(data.id)?.resolve(data.hash);
        hashPending.delete(data.id);
      };
      w.onerror = () => {
        for (const p of hashPending.values()) p.reject(new Error("hash worker failed"));
        hashPending.clear();
      };
      return w;
    });
  } catch (_) {
    hashWorkers = [];
  }
  return hashWorkers;
}

async function sha256Buf(buf) {
  if (globalThis.crypto?.subtle) {
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  const workers = ensureHashWorkers();
  if (!workers.length) return sha256Bytes(new Uint8Array(buf));
  const copy = buf.slice(0);
  return new Promise((resolve, reject) => {
    const id = ++hashSeq;
    hashPending.set(id, { resolve, reject });
    workers[id % workers.length].postMessage({ id, buf: copy }, [copy]);
  }).catch(() => sha256Bytes(new Uint8Array(buf)));
}


async function sha256Blob(blob) {
  const bytes = await blob.arrayBuffer();
  return sha256Buf(bytes);
}

function updateSelectionUI() {
  const count = selectedItems.size;
  let totalBytes = 0;
  selectedItems.forEach(meta => { if (!meta.is_dir) totalBytes += meta.size || 0; });
  document.getElementById("selectionSummary").textContent = `${count} selected`;
  const bar = document.getElementById("selectionActionBar");
  if (count > 0 && (typeof activeTabId === "undefined" || activeTabId === "storageSection")) {
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
  document.getElementById("zipCurrentBtn").dataset.downloadName = `${path.split("/").filter(Boolean).at(-1) || "shared-folder"}.zip`;
  const response = await fetch("/api/list?path=" + encodeURIComponent(path));
  if (!response.ok) throw new Error(await responseError(response));
  const data = await response.json();
  window._sharedFilesLoaded = true;
  currentItems = data.items || [];
  if (data.share_root) {
    currentHostBrowsePath = data.share_root;
    document.getElementById("hostRootText").textContent = data.share_root;
    document.getElementById("hostRootText").title = data.share_root;
    document.getElementById("destinationPath").textContent = `${data.share_root}${path ? `\\${path.replaceAll("/", "\\")}` : ""}`;
  } else {
    document.getElementById("hostRootText").textContent = "Pair and get approval to view the receive folder";
    document.getElementById("hostRootText").title = "";
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
      button.dataset.downloadName = `${item.name}.zip`;
      button.append(icon("archive"), document.createTextNode(" ZIP")); left.appendChild(info); li.append(left, button);
    } else {
      link.href = `/api/download?path=${encoded}`; link.download = "";
      link.dataset.downloadName = item.name; link.dataset.downloadSize = String(item.size || 0);
      link.append(icon("files"), document.createTextNode(` ${item.name}`));
      const meta = document.createElement("div"); meta.className = "file-meta"; meta.textContent = formatBytes(item.size); info.append(link, meta);
      const button = document.createElement("a"); button.href = `/api/download?path=${encoded}`; button.className = "dl-btn"; button.download = "";
      button.dataset.downloadName = item.name;
      button.dataset.downloadSize = String(item.size || 0);
      button.append(icon("download"), document.createTextNode(" Save")); left.appendChild(info); li.append(left, button);
    }
    checkbox.setAttribute("aria-label", `Select ${item.name}`); list.appendChild(li);
  });
  updateSelectionUI();
}

const MAX_IN_PAGE_DOWNLOAD_BYTES = 48 * 1024 * 1024;

function addDownloadRow(filename) {
  const queue = document.getElementById("downloadQueue");
  queue.classList.remove("hidden");
  while (queue.children.length >= 8) queue.firstElementChild.remove();
  const row = document.createElement("li"); row.className = "download-row";
  const info = document.createElement("div"); info.className = "download-row-info";
  const title = document.createElement("strong"); title.textContent = filename;
  const state = document.createElement("span"); state.className = "download-state"; state.textContent = "Connecting to host";
  const progress = document.createElement("progress"); progress.max = 1; progress.value = 0; progress.setAttribute("aria-label", `Downloading ${filename}`);
  const stop = document.createElement("button"); stop.type = "button"; stop.className = "btn-xs outline"; stop.textContent = "Cancel";
  info.append(title, state); row.append(info, stop, progress); queue.prepend(row);
  return { row, title, state, progress, stop };
}

function triggerBrowserDownload(url, filename) {
  const link = document.createElement("a"); link.href = url; link.download = filename; link.hidden = true;
  document.body.appendChild(link); link.click(); link.remove();
}

async function startTrackedDownload(url, filename, expectedSize = 0) {
  const item = addDownloadRow(filename);
  const controller = new AbortController();
  item.stop.onclick = () => controller.abort();
  let writer = null;
  let reader = null;
  let saveHandle = null;
  try {
    if (window.isSecureContext && "showSaveFilePicker" in window) {
      try { saveHandle = await window.showSaveFilePicker({ suggestedName: filename }); }
      catch (error) { if (error.name === "AbortError") throw error; }
    }
    if (!saveHandle && (!expectedSize || expectedSize > MAX_IN_PAGE_DOWNLOAD_BYTES)) {
      item.stop.remove(); item.progress.removeAttribute("value");
      item.state.textContent = "Sent to the browser download manager. Follow its Downloads panel for progress.";
      triggerBrowserDownload(url, filename);
      return;
    }
    const response = await fetch(url, { credentials: "same-origin", headers: deviceHeaders(), signal: controller.signal });
    if (!response.ok) throw new Error(await responseError(response));
    const total = Number(response.headers.get("Content-Length")) || 0;
    reader = response.body?.getReader();
    if (!reader) throw new Error("This browser cannot stream the download. Try a current browser.");
    if (!saveHandle && total > MAX_IN_PAGE_DOWNLOAD_BYTES) {
      await reader.cancel();
      item.stop.remove(); item.progress.removeAttribute("value");
      item.state.textContent = "Large file handed to the browser download manager; follow progress there.";
      triggerBrowserDownload(url, filename);
      return;
    }
    if (saveHandle) writer = await saveHandle.createWritable();
    const chunks = [];
    let received = 0;
    item.state.textContent = total ? `Starting · ${formatBytes(total)}` : "Receiving · size not reported";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (!saveHandle && received > MAX_IN_PAGE_DOWNLOAD_BYTES) {
        await reader.cancel(); chunks.length = 0;
        item.stop.remove(); item.progress.removeAttribute("value");
        item.state.textContent = "Large file handed to the browser download manager; follow progress there.";
        triggerBrowserDownload(url, filename);
        return;
      }
      if (writer) await writer.write(value); else chunks.push(value);
      if (total) { item.progress.max = total; item.progress.value = received; }
      else item.progress.removeAttribute("value");
      item.state.textContent = `${formatBytes(received)}${total ? ` of ${formatBytes(total)}` : " received"}`;
    }
    if (writer) await writer.close();
    else {
      const blob = new Blob(chunks, { type: response.headers.get("Content-Type") || "application/octet-stream" });
      const objectUrl = URL.createObjectURL(blob);
      triggerBrowserDownload(objectUrl, filename);
      chunks.length = 0;
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    }
    item.progress.max = total || Math.max(received, 1); item.progress.value = total || received || 1;
    item.state.textContent = `Saved · ${formatBytes(received)}`;
    item.stop.remove(); item.row.classList.add("download-complete");
  } catch (error) {
    try { await reader?.cancel(); } catch (_) {}
    try { await writer?.abort(); } catch (_) {}
    item.stop.remove();
    if (error.name === "AbortError") { item.state.textContent = "Download cancelled"; item.row.classList.add("download-cancelled"); }
    else { item.state.textContent = `Download failed · ${error.message}`; item.row.classList.add("download-failed"); showNotice(error.message, "error"); }
  }
}

document.getElementById("storageSection").addEventListener("click", event => {
  const link = event.target.closest("a.dl-btn, #zipCurrentBtn, a.file-link[download]");
  if (!link) return;
  event.preventDefault();
  startTrackedDownload(link.href, link.dataset.downloadName || "shared-folder.zip", Number(link.dataset.downloadSize) || 0);
});

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
  if (selectedItems.size) startTrackedDownload(`/api/zip-selected?items=${encodeURIComponent(JSON.stringify([...selectedItems.keys()]))}`, `supershare_selected_${selectedItems.size}.zip`, 0);
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

let uploadInProgress = false;

async function uploadFiles(files, retryName = null) {
  if (!files.length) return;
  if (typeof switchTab === "function" && activeTabId !== "sendSection") switchTab("sendSection", false);
  const box = document.getElementById("progressContainer");
  const name = document.getElementById("uploadFileName");
  const bar = document.getElementById("uploadBarFill");
  const percent = document.getElementById("uploadPercent");
  const speed = document.getElementById("uploadSpeed");
  const queue = document.getElementById("uploadQueue");
  const cancelBtn = document.getElementById("cancelUploadBtn");

  box.classList.remove("hidden");
  if (cancelBtn) cancelBtn.classList.remove("hidden");
  document.querySelector(".running-indicator")?.classList.remove("complete", "failed");

  uploadInProgress = true;
  const uploadAbort = new AbortController();
  if (cancelBtn) {
    cancelBtn.onclick = () => {
      uploadAbort.abort();
      cancelActiveSession();
    };
  }

  let wakeLock = null;
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch (_) {}
  if (!wakeLock && !uploadFiles.warnedSleep) {
    uploadFiles.warnedSleep = true;
    showNotice("Keep this screen on until the transfer finishes. Over HTTP the browser cannot prevent sleep.", "info");
  }

  let skippedFiles = 0;
  const failedFiles = [];

  try {
    const access = await checkUploadPermission();
    if (!access.canSend) throw Object.assign(new Error("The host has not enabled send access for this device."), { status: 403 });
  } catch (error) {
    showNotice(friendlyError(error), "error");
    if (cancelBtn) cancelBtn.classList.add("hidden");
    wakeLock?.release();
    uploadInProgress = false;
    return;
  }

  setConnectionState(`Sending ${files.length} file${files.length === 1 ? "" : "s"}`, "online");
  queue.replaceChildren();
  queue.classList.remove("hidden");

  const queueEntries = Array.from(files, (file, index) => {
    const relative = retryName || relPath(file);
    const row = document.createElement("li");
    const fileName = document.createElement("span"); fileName.className = "upload-queue-name"; fileName.textContent = `${index + 1}. ${relative} · ${formatBytes(file.size)}`;
    const state = document.createElement("span"); state.className = "upload-queue-state"; state.textContent = "Queued"; state.setAttribute("aria-live", "polite");
    const progress = document.createElement("progress"); progress.max = file.size || 1; progress.value = 0; progress.setAttribute("aria-label", `${relative}: queued`);
    row.append(fileName, state, progress); queue.appendChild(row);
    return { state, progress, relative };
  });

  try {
    for (let index = 0; index < files.length; index++) {
      uploadAbort.signal.throwIfAborted();
      const file = files[index];
      const relative = retryName || relPath(file);
      const destination = retryName ? retryName : (currentPath ? `${currentPath}/${relative}` : relative);
      const queueEntry = queueEntries[index];

      queueEntry.state.textContent = "Preparing";
      queueEntry.state.className = "upload-queue-state running";
      name.textContent = `Uploading ${index + 1} of ${files.length}: ${relative}`;
      bar.style.width = "0%";
      percent.textContent = "0%";
      speed.textContent = "Starting";

      try {
        await new Promise((resolve, reject) => {
          (async () => {
            const start = Date.now();
            const headers = { "Content-Type": "application/json", ...deviceHeaders() };
            const resumeKey = `supershare-transfer:${localDeviceId}:${destination}:${file.name}:${file.size}:${file.lastModified}`;
            const resumeId = safeStorage.getItem(resumeKey) || "";
            let collision = "ask";

            let created = await postCreate({
              name: file.name, size: file.size, path: destination, resume_id: resumeId, collision
            }, headers, uploadAbort.signal, t => { speed.textContent = t; });

            if (created.status === 409) {
              collision = await actionDialog({
                title: "Destination file already exists",
                message: `${destination}\n\nChoose how to handle the existing file. Replacing publishes the incoming file only after its chunks verify.`,
                actions: [
                  { label: "Cancel", value: "cancel" },
                  { label: "Skip", value: "skip" },
                  { label: "Keep both", value: "rename" },
                  { label: "Replace after verify", value: "replace", primary: true }
                ]
              }) || "cancel";

              if (collision === "cancel") {
                skippedFiles++;
                queueEntry.state.textContent = "Cancelled";
                queueEntry.state.className = "upload-queue-state";
                resolve();
                return;
              }
              created = await postCreate({
                name: file.name, size: file.size, path: destination, collision
              }, headers, uploadAbort.signal, t => { speed.textContent = t; });
            }

            if (!created.ok) {
              throw Object.assign(new Error(await responseError(created)), { status: created.status });
            }

            const session = await created.json();
            if (session.status === "skipped") {
              skippedFiles++;
              queueEntry.state.textContent = "Skipped";
              queueEntry.state.className = "upload-queue-state";
              resolve();
              return;
            }
            if (session.status === "completed") {
              safeStorage.removeItem(resumeKey);
              queueEntry.state.textContent = "Completed";
              queueEntry.state.className = "upload-queue-state complete";
              queueEntry.progress.value = queueEntry.progress.max;
              resolve();
              return;
            }

            safeStorage.setItem(resumeKey, session.id);
            safeStorage.setItem(`supershare-transfer-time:${localDeviceId}:${destination}:${file.name}:${file.size}:${file.lastModified}`, String(Date.now()));
            activeUpload = { id: session.id, resumeKey };

            let offset = session.offset || 0;
            const resumeOffset = offset;
            const chunkSize = session.chunk_size || (4 * 1024 * 1024);
            let uploadedBytes = offset;

            queueEntry.progress.value = Math.min(uploadedBytes, file.size || 1);
            queueEntry.progress.setAttribute("aria-label", `${relative}: resumed at ${formatBytes(offset)} of ${formatBytes(file.size)}`);
            queueEntry.state.textContent = "Transferring";

            const chunkOffsets = [];
            for (let pos = offset; pos < file.size; pos += chunkSize) {
              chunkOffsets.push(pos);
            }

            let lastT = start, lastB = uploadedBytes, ema = 0;
            const render = () => {
              const now = Date.now();
              if (now - lastT >= 1000) {
                const inst = Math.max(0, uploadedBytes - lastB) / ((now - lastT) / 1000);
                ema = ema ? ema * 0.7 + inst * 0.3 : inst;
                lastT = now;
                lastB = uploadedBytes;
              }
              const pct = file.size ? Math.min(100, Math.round(uploadedBytes / file.size * 100)) : 100;
              const rate = ema;
              const eta = rate > 0 ? ` · ETA ${formatDuration((file.size - uploadedBytes) / rate)}` : "";
              bar.style.width = `${pct}%`;
              percent.textContent = `${pct}%`;
              queueEntry.progress.value = Math.min(uploadedBytes, file.size || 1);
              speed.textContent = `${formatBytes(uploadedBytes)} / ${formatBytes(file.size)} · ${formatBytes(rate)}/s${eta}`;
              queueEntry.state.textContent = `${pct}% · ${formatBytes(rate)}/s${eta}`;
            };

            await sendChunks({
              session, file, offsets: chunkOffsets, chunkSize, signal: uploadAbort.signal,
              onBytes: d => { uploadedBytes += d; render(); },
              onStatus: s => { speed.textContent = s; }
            });

            name.textContent = `Verifying ${file.name}`;
            queueEntry.state.textContent = "Verifying";
            speed.textContent = "Verifying chunks and final file checksum";

            let completed = await finishTransfer(session, headers, uploadAbort.signal, (verified, total) => {
              speed.textContent = `Verifying ${formatBytes(verified)} of ${formatBytes(total)}`;
            });

            for (let pass = 0; completed.error === "chunks_corrupt" && pass < 3; pass++) {
              showNotice(`Repairing ${completed.bad_offsets.length} damaged chunk(s)...`, "info");
              await sendChunks({
                session, file, offsets: completed.bad_offsets, chunkSize, signal: uploadAbort.signal,
                onBytes: () => {}, onStatus: s => { speed.textContent = s; }
              });
              completed = await finishTransfer(session, headers, uploadAbort.signal);
            }

            if (completed.error) {
              throw new Error("The laptop could not verify this file after re-sending damaged chunks.");
            }

            safeStorage.removeItem(resumeKey);
            activeUpload = { id: null, resumeKey: null };
            queueEntry.state.textContent = "Completed";
            queueEntry.state.className = "upload-queue-state complete";
            queueEntry.progress.value = queueEntry.progress.max;
            resolve();
          })().catch(reject);
        });
      } catch (fileErr) {
        if (fileErr.name === "AbortError") throw fileErr;
        failedFiles.push(relative);
        queueEntry.state.textContent = `Failed · ${friendlyError(fileErr)}`;
        queueEntry.state.className = "upload-queue-state failed";
        continue;
      }
    }

    const successCount = files.length - skippedFiles - failedFiles.length;
    name.textContent = `Completed ${successCount}; skipped ${skippedFiles}; failed ${failedFiles.length}`;
    percent.textContent = "100%";
    bar.style.width = "100%";
    document.querySelector(".running-indicator")?.classList.add(failedFiles.length ? "failed" : "complete");
    setConnectionState("Batch transfer finished", "online");
    showNotice(`Sent ${successCount}; skipped ${skippedFiles}; failed ${failedFiles.length} to ${document.getElementById("destinationName").textContent}.`, failedFiles.length ? "error" : "success");
    fetchDirectory(currentPath);
    refreshDevices();
  } catch (err) {
    name.textContent = err.name === "AbortError" ? "Transfer cancelled" : "Transfer failed";
    queueEntries.forEach(entry => {
      if (entry.state.textContent === "Queued") entry.state.textContent = "Not started · cancelled/aborted";
    });
    document.querySelector(".running-indicator")?.classList.add("failed");
    setConnectionState(friendlyError(err), "error");
    showNotice(friendlyError(err), "error");
    refreshDevices();
  } finally {
    wakeLock?.release();
    if (cancelBtn) cancelBtn.classList.add("hidden");
    uploadInProgress = false;
  }
}

const JUNK_FILE_RE = /^(\.DS_Store|Thumbs\.db|desktop\.ini|\._.*|~\$.*|.*\.crdownload)$/i;

function sanitizeUploadFiles(rawFiles) {
  const all = Array.from(rawFiles || []);
  const kept = all.filter(file => !relPath(file).replace(/\\/g, "/").split("/")
    .some(p => JUNK_FILE_RE.test(p) || p.startsWith(".supershare-") || p.endsWith(".partial")));
  const dropped = all.length - kept.length;
  if (dropped) {
    showNotice(`${dropped} system or in-progress file(s) were skipped (.DS_Store, Thumbs.db, ~$ lock files, .crdownload).`, "info");
  }
  return kept;
}

document.getElementById("fileInput").onchange = event => {
  const files = sanitizeUploadFiles(event.target.files);
  event.target.value = "";
  if (files.length) uploadFiles(files);
};

document.getElementById("folderInput").onchange = event => {
  const files = sanitizeUploadFiles(event.target.files);
  event.target.value = "";
  if (files.length) uploadFiles(files);
};
const dropZone = document.getElementById("dropZone");
dropZone.addEventListener("dragover", event => { event.preventDefault(); dropZone.classList.add("drag-active"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-active"));
dropZone.addEventListener("drop", async event => {
  event.preventDefault();
  dropZone.classList.remove("drag-active");
  const files = sanitizeUploadFiles(await filesFromDataTransfer(event.dataTransfer));
  if (files.length) uploadFiles(files);
});

document.addEventListener("paste", event => {
  const files = sanitizeUploadFiles(event.clipboardData?.files);
  if (files.length) uploadFiles(files);
});
document.getElementById("newFolderBtn").onclick = async () => {
  const name = await editText("Create a folder", "The folder will be created inside the current shared location.", "Folder name"); if (!name) return;
  const path = currentPath ? `${currentPath}/${name}` : name;
  const response = await fetch("/api/mkdir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
  if (response.ok) fetchDirectory(currentPath); else showNotice(await responseError(response), "error");
};



/* --- Interactive Tab Navigation & Live Tab Counters --- */
let activeTabId = "sendSection";

function switchTab(targetSectionId, updateHash = false) {
  const tabs = document.querySelectorAll(".tab-btn[data-tab]");
  const panels = document.querySelectorAll(".tab-panel");
  if (!tabs.length || !panels.length) return;

  activeTabId = targetSectionId;

  tabs.forEach(tab => {
    const isTarget = tab.dataset.tab === targetSectionId;
    tab.classList.toggle("active", isTarget);
    tab.setAttribute("aria-selected", isTarget ? "true" : "false");
    tab.setAttribute("tabindex", isTarget ? "0" : "-1");
  });

  panels.forEach(panel => {
    const isTarget = panel.id === targetSectionId;
    panel.classList.toggle("tab-hidden", !isTarget);
  });

  if (typeof updateSelectionUI === "function") {
    updateSelectionUI();
  }

  if (updateHash && history.replaceState) {
    history.replaceState(null, "", `#${targetSectionId}`);
  }
}

function initTabNavigation() {
  const tabs = Array.from(document.querySelectorAll(".tab-btn[data-tab]"));
  if (!tabs.length) return;

  tabs.forEach((tab, idx) => {
    tab.addEventListener("click", () => {
      switchTab(tab.dataset.tab, true);
    });

    tab.addEventListener("keydown", event => {
      let nextIndex = null;
      if (event.key === "ArrowRight") nextIndex = (idx + 1) % tabs.length;
      else if (event.key === "ArrowLeft") nextIndex = (idx - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = tabs.length - 1;

      if (nextIndex !== null) {
        event.preventDefault();
        tabs[nextIndex].focus();
        switchTab(tabs[nextIndex].dataset.tab, true);
      }
    });
  });

  const hashTarget = location.hash ? location.hash.slice(1) : "";
  const validPanelIds = new Set(tabs.map(t => t.dataset.tab));
  if (pairingCodeFromQr) {
    switchTab("sendSection", false);
  } else if (hashTarget && validPanelIds.has(hashTarget)) {
    switchTab(hashTarget, false);
  } else {
    switchTab("sendSection", false);
  }

  window.addEventListener("dragenter", event => {
    if (event.dataTransfer?.types?.includes("Files") && activeTabId !== "sendSection") {
      switchTab("sendSection", false);
    }
  });
}

function syncTabIndicators() {
  const devices = window._lastDevices || [];
  const transfers = (window._lastTransfers || []).filter(t => !String(t.device_id || "").startsWith("benchmark-"));
  const activeStates = ["queued", "transferring", "interrupted", "verifying"];

  const deviceBadge = document.getElementById("tabDeviceBadge");
  if (deviceBadge) deviceBadge.textContent = String(devices.length);

  const nowSec = Math.floor(Date.now() / 1000);
  const hasPendingDevice = devices.some(device => {
    const isThisProfile = device.id === localDeviceId;
    if (isThisProfile) return false;
    const paired = Boolean(device.paired);
    const phraseConfirmed = Boolean(device.pair_confirmed);
    const accessActive = Boolean(device.trusted || (device.approved_until || 0) > nowSec);
    const hasPermission = Boolean(device.permissions?.read || device.permissions?.write);
    return !paired || !(phraseConfirmed && accessActive && hasPermission);
  });

  const deviceDot = document.getElementById("tabDeviceDot");
  if (deviceDot) deviceDot.classList.toggle("hidden", !hasPendingDevice);

  const phrasePanel = document.getElementById("pairPhrasePanel");
  const pairBtn = document.getElementById("pairDeviceBtn");
  const needsSendAttention = (phrasePanel && !phrasePanel.classList.contains("hidden")) || (pairBtn && !pairBtn.classList.contains("hidden"));
  const sendDot = document.getElementById("tabSendDot");
  if (sendDot) sendDot.classList.toggle("hidden", !needsSendAttention);

  const transferBadge = document.getElementById("tabTransferBadge");
  const activeCount = transfers.filter(t => activeStates.includes(t.status)).length;
  if (transferBadge) {
    transferBadge.textContent = String(activeCount > 0 ? activeCount : transfers.length);
    transferBadge.classList.toggle("active-count", activeCount > 0);
  }
}

document.getElementById("quickQrBtn")?.addEventListener("click", () => {
  if (typeof switchTab === "function") switchTab("networkSection", true);
  document.getElementById("showPairQrBtn")?.click();
});
initTabNavigation();
fetchDirectory().catch(showDirectoryError);
refreshDevices();
refreshNetworkInfo();
setInterval(() => { if (!document.hidden) refreshDevices(); }, 5000);
setInterval(() => { if (!document.hidden) refreshNetworkInfo(); }, 30000);


/* --- Storage Management & Data Maintenance --- */
async function refreshStorageInfo() {
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

// Refresh storage info when switching to storage tab
const origSwitchTab = switchTab;
switchTab = function(targetSectionId, updateHash = false) {
  origSwitchTab(targetSectionId, updateHash);
  if (targetSectionId === "storageMgrSection" || targetSectionId === "storageSection") {
    refreshStorageInfo();
  }
};

setInterval(() => { if (!document.hidden && activeTabId === "storageMgrSection") refreshStorageInfo(); }, 25000);

document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshDevices(); });

refreshDevices().then(() => { if (pairingCodeFromQr && !window._profilePaired) pairThisDevice(); });
