// static/js/pages/devices.js
// Access Control & Connected Devices listing, rename, forget, and status indicators

import { showNotice, responseError, editText, confirmAction, icon, listBusy } from "../services/utils.js";
import { localDeviceId, deviceHeaders } from "../services/device.js";

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

export async function refreshDevices() {
  try {
    const response = await fetch("/api/status", { headers: deviceHeaders() });
    if (!response.ok) throw new Error(await responseError(response));
    const data = await response.json();

    document.getElementById("openDriveBrowserBtn")?.classList.toggle("hidden", !data.host_dashboard);
    document.getElementById("nativePickerBtn")?.classList.toggle("hidden", !data.host_dashboard);
    document.getElementById("showPairQrBtn")?.classList.toggle("hidden", !data.host_dashboard);
    document.getElementById("deleteSelectedBtn")?.classList.toggle("hidden", !data.host_dashboard);
    document.getElementById("quickQrBtn")?.classList.toggle("hidden", !data.host_dashboard);
    document.getElementById("tab-storage-mgr")?.classList.toggle("hidden", !data.host_dashboard);

    document.getElementById("destinationName").textContent = data.host_name || "This host";
    window._shareRoot = data.share_root || "";

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
        empty.textContent = data.host_dashboard
          ? "Waiting for browser profiles to connect…"
          : "Browser profile status is managed from the laptop dashboard.";
        list.appendChild(empty);
      }
      devices.forEach(device => {
        const li = document.createElement("li");
        li.className = "device-row";
        const main = document.createElement("div");
        main.className = "device-main";
        const avatar = document.createElement("span");
        avatar.className = "device-avatar";
        avatar.appendChild(icon(/Android|iOS|iPhone|iPad/i.test(device.type) ? "device-mobile" : "monitor"));
        const info = document.createElement("div");
        info.className = "device-info";
        const title = document.createElement("strong");
        title.textContent = device.name + (device.id === localDeviceId ? " (this device)" : "");
        const seenAt = new Date(device.last_seen * 1000);
        const elapsed = Math.max(0, Math.floor(Date.now() / 1000 - device.last_seen));
        const seenText = elapsed < 60 ? `${elapsed}s ago` : elapsed < 3600 ? `${Math.floor(elapsed / 60)}m ago` : seenAt.toLocaleString();
        const meta = document.createElement("span");
        meta.textContent = `${device.type} · ${device.ip || "local network"} · last seen ${seenText}`;
        const identity = document.createElement("code");
        identity.className = "device-identity";
        identity.textContent = `Browser profile ID · ${String(device.id).slice(0, 8)}`;
        identity.title = String(device.id);
        const approval = document.createElement("span");
        approval.textContent = "Always allowed · Full access";
        info.append(title, meta, identity, approval);
        main.append(avatar, info);

        const state = document.createElement("span");
        state.className = `device-state ${device.online ? "online" : "offline"}`;
        state.textContent = `${device.online ? "Online" : "Offline"} · Ready to Share · Read + Send`;
        li.append(main, state);

        const controls = document.createElement("div");
        controls.className = "device-controls";
        const rename = document.createElement("button");
        rename.className = "btn-xs outline";
        rename.textContent = "Rename";
        rename.onclick = async () => {
          const name = await editText("Name device", "Give this device a recognizable name:", "Display name", device.name);
          if (!name) return;
          const ok = await deviceAction("/api/devices/rename", { id: device.id, name });
          if (ok) refreshDevices();
        };
        controls.appendChild(rename);
        if (device.id !== localDeviceId) {
          const forget = document.createElement("button");
          forget.className = "btn-xs outline";
          forget.textContent = "Remove";
          forget.onclick = async () => {
            if (await confirmAction("Remove device?", `Remove ${device.name} from the devices list?`, true)
                && await deviceAction("/api/devices/forget", { id: device.id })) {
              refreshDevices();
            }
          };
          controls.appendChild(forget);
        }
        li.append(controls);
        list.appendChild(li);
      });
    }

    window._lastTransfers = data.transfers || [];
    renderTransfers(window._lastTransfers, data.host_dashboard);
    syncTabIndicators();
  } catch (_) {
    // Host offline
  }
}

export function renderTransfers(transfers, hostDashboard) {
  const list = document.getElementById("transferList");
  if (!list || listBusy(list)) return;
  list.replaceChildren();

  if (!hostDashboard) {
    list.innerHTML = '<li class="empty-state">Transfer activity logs are available on the laptop dashboard.</li>';
    return;
  }

  const filter = document.getElementById("transferFilter")?.value || "all";
  const activeStates = ["queued", "transferring", "interrupted", "verifying"];
  const filtered = [...transfers]
    .filter(t => !String(t.device_id || "").startsWith("benchmark-"))
    .filter(t => filter === "all" || (filter === "active" ? activeStates.includes(t.status) : t.status === filter))
    .reverse();

  if (!filtered.length) {
    list.innerHTML = '<li class="empty-state">No transfers recorded yet.</li>';
    return;
  }

  filtered.forEach(t => {
    const li = document.createElement("li");
    li.className = "transfer-row";
    const info = document.createElement("div");
    info.className = "transfer-info";
    const name = document.createElement("strong");
    name.textContent = t.filename || "Unknown file";
    const meta = document.createElement("span");
    const dir = t.direction === "send" ? "Sent" : "Received";
    const timeStr = t.timestamp ? new Date(t.timestamp * 1000).toLocaleTimeString() : "";
    meta.textContent = `${dir} · ${timeStr} · ${t.detail || t.status}`;
    info.append(name, meta);

    const st = document.createElement("span");
    st.className = `transfer-status-badge ${t.status}`;
    st.textContent = t.status;
    li.append(info, st);
    list.appendChild(li);
  });
}

export function syncTabIndicators() {
  const devices = window._lastDevices || [];
  const transfers = (window._lastTransfers || []).filter(t => !String(t.device_id || "").startsWith("benchmark-"));
  const activeStates = ["queued", "transferring", "interrupted", "verifying"];

  const deviceBadge = document.getElementById("tabDeviceBadge");
  if (deviceBadge) deviceBadge.textContent = String(devices.length);

  const transferBadge = document.getElementById("tabTransferBadge");
  const activeCount = transfers.filter(t => activeStates.includes(t.status)).length;
  if (transferBadge) {
    transferBadge.textContent = String(activeCount > 0 ? activeCount : transfers.length);
    transferBadge.classList.toggle("active-count", activeCount > 0);
  }
}

export function initDevicesPage() {
  document.getElementById("transferFilter")?.addEventListener("change", () => {
    renderTransfers(window._lastTransfers || [], true);
  });
}

