// static/js/app.js
// Main Application Entry Point & Module Orchestrator

import { initRouter, onRouteChanged, navigateTo } from "./services/router.js";
import { initPreviewListeners } from "./services/preview.js";
import { localDeviceId, localDeviceName } from "./services/device.js";

import { initConnectPage, refreshNetworkInfo } from "./pages/connect.js";
import { initDevicesPage, refreshDevices } from "./pages/devices.js";
import {
  initExplorerPage,
  initExplorerEnhancements,
  fetchDirectory,
  showDirectoryError,
  setFileViewMode,
  updateSelectionUI,
} from "./pages/explorer.js";
import { initSendPage } from "./pages/send.js";
import { initStorageMgrPage, refreshStorageInfo } from "./pages/storage_mgr.js";

initConnectPage();
initDevicesPage();
initExplorerPage();
initExplorerEnhancements();
initSendPage();
initStorageMgrPage();
initPreviewListeners();

setFileViewMode(localStorage.getItem("supershare-file-view-mode") || "grid");
initRouter();

const srcNameEl = document.getElementById("sourceDeviceName");
if (srcNameEl) srcNameEl.textContent = localDeviceName;
const srcProfEl = document.getElementById("sourceProfileId");
if (srcProfEl) srcProfEl.textContent = `Profile ID · ${localDeviceId.slice(0, 8)}`;

onRouteChanged((sectionId) => {
  if (sectionId === "storageSection" && !window._sharedFilesLoaded)
    fetchDirectory().catch(showDirectoryError);
  if (sectionId === "storageMgrSection") refreshStorageInfo();
  if (sectionId === "devicesSection" || sectionId === "transfersSection") refreshDevices();
  if (sectionId === "networkSection") refreshNetworkInfo();
  updateSelectionUI(); // the floating selection bar only belongs on the Files tab
});

// Esc dismisses the notice banner
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
    document.getElementById("notice")?.classList.add("hidden");
  }
});

document.getElementById("quickQrBtn")?.addEventListener("click", () => {
  navigateTo("networkSection", true);
  document.getElementById("showPairQrBtn")?.click();
});

fetchDirectory().catch(showDirectoryError);
refreshNetworkInfo();
refreshStorageInfo();

(function pollDevices() {
  const busy = (window._lastTransfers || []).some((t) =>
    ["queued", "transferring", "verifying"].includes(t.status)
  );
  if (!document.hidden) refreshDevices();
  setTimeout(pollDevices, busy ? 1500 : 5000);
})();
setInterval(() => {
  if (!document.hidden) refreshNetworkInfo();
}, 30000);
setInterval(() => {
  if (!document.hidden) refreshStorageInfo();
}, 60000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshDevices();
    refreshNetworkInfo();
    refreshStorageInfo();
  }
});
