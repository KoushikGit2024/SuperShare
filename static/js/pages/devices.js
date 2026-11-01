// static/js/pages/devices.js
import { showNotice, responseError, editText, confirmAction, icon, listBusy, formatBytes } from "../services/utils.js";
import { localDeviceId, deviceHeaders, setConnectionState } from "../services/device.js";

export async function deviceAction(url, body) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...deviceHeaders() },
      credentials: "same-origin",
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(await responseError(response));
    return true;
  } catch (error) {
    showNotice(error.message || "Device action failed", "error");
    return false;
  }
}

const ACTIVE_STATES = ["queued", "transferring", "interrupted", "verifying"];
const ACCESS_OPTIONS = [["read-write", "Read + Send"], ["read-only", "Read only"], ["blocked", "Blocked"]];
const LIMIT_OPTIONS = [[0, "No limit"], [512, "512 KB/s"], [1024, "1 MB/s"], [5120, "5 MB/s"], [20480, "20 MB/s"]];

function platformInfo(type) {
  const t = String(type || "");
  if (/iPad/i.test(t)) return { label: "iPadOS", icon: "tablet" };
  if (/iOS|iPhone/i.test(t)) return { label: "iOS", icon: "device-mobile" };
  if (/Android/i.test(t)) return { label: "Android", icon: "device-mobile" };
  if (/Mac/i.test(t)) return { label: "macOS", icon: "laptop" };
  if (/Linux|CrOS|Chrome OS/i.test(t)) return { label: "Linux", icon: "monitor" };
  if (/Win/i.test(t)) return { label: "Windows", icon: "monitor" };
  return { label: "Browser", icon: "monitor" };
}

function pill(text, className = "", iconName = "") {
  const el = document.createElement("span");
  el.className = `device-pill ${className}`.trim();
  if (iconName) el.appendChild(icon(iconName));
  el.append(document.createTextNode(iconName ? ` ${text}` : text));
  return el;
}

function selectControl(label, options, value, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "device-select";
  const text = document.createElement("span");
  text.textContent = label;
  const select = document.createElement("select");
  options.forEach(([val, name]) => {
    const option = document.createElement("option");
    option.value = String(val);
    option.textContent = name;
    select.appendChild(option);
  });
  select.value = String(value);
  select.onchange = () => onChange(select.value);
  wrap.append(text, select);
  return wrap;
}

function smallButton(text, handler, className = "btn-xs outline") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  button.onclick = handler;
  return button;
}

function buildDeviceRow(device, host) {
  const isSelf = device.id === localDeviceId;
  const platform = platformInfo(device.type);
  const li = document.createElement("li");
  li.className = "device-row";
  li.dataset.deviceId = device.id;

  const main = document.createElement("div");
  main.className = "device-main";
  const avatar = document.createElement("span");
  avatar.className = "device-avatar";
  avatar.appendChild(icon(platform.icon));
  const info = document.createElement("div");
  info.className = "device-info";
  const title = document.createElement("strong");
  title.textContent = device.name + (isSelf ? " (this device)" : "");

  const pills = document.createElement("div");
  pills.className = "device-pills";
  pills.append(pill(platform.label, "platform", platform.icon));
  if (device.ip) pills.append(pill(device.ip, "ip"));
  if (device.connection) pills.append(pill(device.connection, "connection", "route"));
  pills.append(pill(device.access === "blocked" ? "Blocked" : device.access === "read-only" ? "Read only" : "Read + Send",
    `access ${device.access}`));
  if (device.paused) pills.append(pill("Paused", "paused"));
  if (device.limit_kbps) pills.append(pill(`Limit ${formatBytes(device.limit_kbps * 1024)}/s`, "limit"));
  if (device.active_transfers) pills.append(pill(`${device.active_transfers} active`, "active"));

  const elapsed = Math.max(0, Math.floor(Date.now() / 1000 - device.last_seen));
  const seenText = elapsed < 60 ? `${elapsed}s ago` : elapsed < 3600 ? `${Math.floor(elapsed / 60)}m ago`
    : new Date(device.last_seen * 1000).toLocaleString();
  const meta = document.createElement("span");
  meta.textContent = `${device.type} · last seen ${seenText}`;
  const identity = document.createElement("code");
  identity.className = "device-identity";
  identity.textContent = `Browser profile ID · ${String(device.id).slice(0, 8)}`;
  identity.title = String(device.id);
  info.append(title, pills, meta, identity);
  main.append(avatar, info);

  const state = document.createElement("span");
  state.className = `device-state ${device.online ? "online" : "offline"}`;
  state.textContent = device.online ? "Online" : "Offline";
  li.append(main, state);

  const controls = document.createElement("div");
  controls.className = "device-controls";
  const refresh = ok => { if (ok) refreshDevices(); };

  controls.appendChild(smallButton("Rename", async () => {
    const name = await editText("Name device", "Give this device a recognizable name:", "Display name", device.name);
    if (name) refresh(await deviceAction("/api/devices/rename", { id: device.id, name }));
  }));

  if (host && !isSelf) {
    controls.append(
      selectControl("Access", ACCESS_OPTIONS, device.access, async value =>
        refresh(await deviceAction("/api/devices/policy", { id: device.id, access: value }))),
      selectControl("Speed", LIMIT_OPTIONS, device.limit_kbps, async value =>
        refresh(await deviceAction("/api/devices/policy", { id: device.id, limit_kbps: Number(value) }))),
      smallButton(device.paused ? "Resume" : "Pause", async () =>
        refresh(await deviceAction("/api/devices/policy", { id: device.id, paused: !device.paused })))
    );
    if (device.active_transfers) {
      controls.appendChild(smallButton("Stop transfers", async () => {
        if (await confirmAction("Stop transfers?", `Cancel every active upload from ${device.name} and delete its partial files?`, true)) {
          refresh(await deviceAction("/api/devices/terminate", { id: device.id }));
        }
      }));
    }
    controls.appendChild(smallButton("Kick", async () => {
      if (await confirmAction("Kick this browser?", `${device.name} will be blocked and its active uploads cancelled. You can unblock it from the Access menu.`, true)) {
        refresh(await deviceAction("/api/devices/policy", { id: device.id, access: "blocked" }));
      }
    }, "btn-xs outline"));
    controls.appendChild(smallButton("Remove", async () => {
      if (await confirmAction("Remove device?", `Remove ${device.name} from the devices list?`, true)) {
        refresh(await deviceAction("/api/devices/forget", { id: device.id }));
      }
    }));
  }
  li.append(controls);
  return li;
}

export async function refreshDevices() {
  try {
    const response = await fetch("/api/status", { headers: deviceHeaders() });
    if (!response.ok) throw new Error(await responseError(response));
    const data = await response.json();
    const host = Boolean(data.host_dashboard);
    window._isHostDashboard = host;

    document.getElementById("openDriveBrowserBtn")?.classList.toggle("hidden", !host);
    document.getElementById("nativePickerBtn")?.classList.toggle("hidden", !host);
    document.getElementById("showPairQrBtn")?.classList.toggle("hidden", !host);
    document.getElementById("deleteSelectedBtn")?.classList.toggle("hidden", !host);
    document.getElementById("quickQrBtn")?.classList.toggle("hidden", !host);
    document.getElementById("tab-storage-mgr")?.classList.toggle("hidden", !host);

    document.getElementById("destinationName").textContent = data.host_name || "This host";
    window._shareRoot = data.share_root || "";
    if (!host && data.access === "blocked") setConnectionState("Blocked by the host", "error");

    const devices = data.devices || [];
    window._lastDevices = devices;
    const countEl = document.getElementById("deviceCount");
    if (countEl) countEl.textContent = `${devices.length} profile${devices.length === 1 ? "" : "s"}`;

    const list = document.getElementById("deviceList");
    if (list && !listBusy(list)) {
      list.replaceChildren();
      if (!devices.length) {
        const empty = document.createElement("li");
        empty.className = "empty-state";
        empty.textContent = host
          ? "Waiting for browser profiles to connect…"
          : "Browser profile status is managed from the laptop dashboard.";
        list.appendChild(empty);
      }
      devices.forEach(device => list.appendChild(buildDeviceRow(device, host)));
    }

    window._lastTransfers = host ? (data.transfers || []) : (data.my_transfers || []);
    renderTransfers(window._lastTransfers, host);
    syncTabIndicators();
  } catch (_) {
    // Host offline
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function renderThroughput(transfers) {
  const svg = document.getElementById("throughputChart");
  const peakEl = document.getElementById("throughputPeak");
  if (!svg) return;
  const BUCKETS = 15;
  const nowMin = Math.floor(Date.now() / 60000);
  const bytes = new Array(BUCKETS).fill(0);
  transfers.forEach(t => {
    if (t.status !== "completed" || !t.timestamp || String(t.device_id || "").startsWith("benchmark-")) return;
    const age = nowMin - Math.floor(t.timestamp / 60);
    if (age >= 0 && age < BUCKETS) bytes[BUCKETS - 1 - age] += Number(t.size) || 0;
  });
  const peak = Math.max(...bytes);
  svg.replaceChildren();
  const barWidth = 300 / BUCKETS;
  bytes.forEach((value, index) => {
    const height = peak ? Math.max(value ? 2 : 0, (value / peak) * 66) : 0;
    const bar = document.createElementNS(SVG_NS, "rect");
    bar.setAttribute("x", String(index * barWidth + 1));
    bar.setAttribute("y", String(70 - height));
    bar.setAttribute("width", String(barWidth - 2));
    bar.setAttribute("height", String(height));
    bar.setAttribute("class", "throughput-bar");
    svg.appendChild(bar);
  });
  if (peakEl) peakEl.textContent = peak ? `Peak ${formatBytes(peak)}/min` : "No completed transfers yet";
}

let deviceFilterSignature = "";
function syncDeviceFilter(host) {
  const select = document.getElementById("transferDevice");
  if (!select) return;
  select.closest("label")?.classList.toggle("hidden", !host);
  if (!host) return;
  const devices = window._lastDevices || [];
  const signature = devices.map(d => `${d.id}:${d.name}`).join("|");
  if (signature === deviceFilterSignature) return;
  deviceFilterSignature = signature;
  const previous = select.value || "all";
  select.replaceChildren(new Option("All devices", "all"));
  devices.forEach(d => select.appendChild(new Option(d.name, d.id)));
  select.value = devices.some(d => d.id === previous) ? previous : "all";
}

function transferRow(t, host, names) {
  const active = ACTIVE_STATES.includes(t.status);
  const who = names.get(t.device_id) || "Unknown device";
  const outgoing = t.direction === "send";
  const verb = outgoing
    ? (active ? (host ? `Sending to ${who}` : "Downloading") : (host ? `Sent to ${who}` : "Downloaded"))
    : active ? (host ? `Receiving from ${who}` : "Uploading")
      : (host ? `Received from ${who}` : "Uploaded");

  const li = document.createElement("li");
  li.className = "transfer-row";
  const info = document.createElement("div");
  info.className = "transfer-info";
  const name = document.createElement("strong");
  name.textContent = t.filename || "Unknown file";
  const meta = document.createElement("span");
  const timeStr = t.timestamp ? new Date(t.timestamp * 1000).toLocaleTimeString() : "";
  meta.textContent = `${verb} · ${timeStr} · ${t.detail || t.status}`;
  info.append(name, meta);
  if (active && t.size) {
    const pct = Math.round(Math.min(t.offset || 0, t.size) / t.size * 100);
    const progress = document.createElement("progress");
    progress.className = "transfer-progress";
    progress.max = t.size;
    progress.value = Math.min(t.offset || 0, t.size);
    progress.setAttribute("aria-label", `${t.filename}: ${pct}% received`);
    info.appendChild(progress);
  }

  const side = document.createElement("span");
  side.className = "transfer-side";
  const st = document.createElement("span");
  st.className = `transfer-state ${t.status}`;
  st.textContent = t.status;
  side.appendChild(st);
  if (active && t.id && (!outgoing || host)) {
    side.appendChild(smallButton("Stop", async () => {
      try {
        const res = outgoing
          ? await fetch("/api/downloads/stop", { method: "POST", headers: { "Content-Type": "application/json", ...deviceHeaders() },
              credentials: "same-origin", body: JSON.stringify({ id: t.id }) })
          : await fetch(`/api/transfers/${t.id}/cancel`, { method: "POST", headers: deviceHeaders(), credentials: "same-origin" });
        if (!res.ok) throw new Error(await responseError(res));
        refreshDevices();
      } catch (error) {
        showNotice(error.message, "error");
      }
    }));
  }
  li.append(info, side);
  return li;
}

export function renderTransfers(transfers, hostDashboard) {
  const list = document.getElementById("transferList");
  if (!list || listBusy(list)) return;
  list.replaceChildren();

  const titleText = document.getElementById("activityTitleText");
  if (titleText) titleText.textContent = hostDashboard ? "Activity" : "My transfers";
  document.getElementById("throughputPanel")?.classList.toggle("hidden", !hostDashboard);
  syncDeviceFilter(hostDashboard);
  if (hostDashboard) renderThroughput(transfers);

  const names = new Map((window._lastDevices || []).map(d => [d.id, d.name]));
  const statusFilter = document.getElementById("transferFilter")?.value || "all";
  const scope = hostDashboard ? (document.getElementById("transferDevice")?.value || "all") : "all";
  const filtered = [...transfers]
    .filter(t => !String(t.device_id || "").startsWith("benchmark-"))
    .filter(t => scope === "all" || t.device_id === scope)
    .filter(t => statusFilter === "all" || (statusFilter === "active" ? ACTIVE_STATES.includes(t.status) : t.status === statusFilter))
    .reverse();

  if (!filtered.length) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = hostDashboard ? "No transfers match this view." : "You haven't sent or received anything in this browser yet.";
    list.appendChild(empty);
    return;
  }
  filtered.forEach(t => list.appendChild(transferRow(t, hostDashboard, names)));
}

export function syncTabIndicators() {
  const devices = window._lastDevices || [];
  const transfers = (window._lastTransfers || []).filter(t => !String(t.device_id || "").startsWith("benchmark-"));
  const activeCount = transfers.filter(t => ACTIVE_STATES.includes(t.status)).length;

  const deviceBadge = document.getElementById("tabDeviceBadge");
  if (deviceBadge) deviceBadge.textContent = String(devices.length);

  const transferBadge = document.getElementById("tabTransferBadge");
  if (transferBadge) {
    transferBadge.textContent = String(activeCount > 0 ? activeCount : transfers.length);
    transferBadge.classList.toggle("active-count", activeCount > 0);
  }
}

export function initDevicesPage() {
  const rerender = () => renderTransfers(window._lastTransfers || [], Boolean(window._isHostDashboard));
  document.getElementById("transferFilter")?.addEventListener("change", rerender);
  document.getElementById("transferDevice")?.addEventListener("change", rerender);

  document.getElementById("removeOfflineBtn")?.addEventListener("click", async () => {
    const stale = (window._lastDevices || []).filter(d => !d.online && d.id !== localDeviceId);
    if (!stale.length) return showNotice("No offline browsers to remove.", "info");
    if (!await confirmAction("Remove offline browsers?", `Remove ${stale.length} offline profile(s)? They reappear if they reconnect.`, true)) return;
    for (const d of stale) await deviceAction("/api/devices/forget", { id: d.id });
    refreshDevices();
  });
}
