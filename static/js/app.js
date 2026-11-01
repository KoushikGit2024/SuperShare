// static/js/app.js
// Main Application Entry Point & Module Orchestrator

import { initRouter, onRouteChanged, navigateTo } from "./services/router.js";
import { initPreviewListeners } from "./services/preview.js";
import { localDeviceId, localDeviceName } from "./services/device.js";

import { initConnectPage, refreshNetworkInfo } from "./pages/connect.js";
import { initDevicesPage, refreshDevices } from "./pages/devices.js";
import { initExplorerPage, fetchDirectory, showDirectoryError, setFileViewMode } from "./pages/explorer.js";
import { initSendPage } from "./pages/send.js";
import { initStorageMgrPage, refreshStorageInfo } from "./pages/storage_mgr.js";

// Initialize UI Page Handlers
initConnectPage();
initDevicesPage();
initExplorerPage();
initSendPage();
initStorageMgrPage();
initPreviewListeners();

// Ensure initial file view mode (grid/tile default) is applied immediately
setFileViewMode(localStorage.getItem("supershare-file-view-mode") || "grid");

// Initialize Client-side URL Routing & Redirection
initRouter();

// Synchronize profile labels
const srcNameEl = document.getElementById("sourceDeviceName");
if (srcNameEl) srcNameEl.textContent = localDeviceName;
const srcProfEl = document.getElementById("sourceProfileId");
if (srcProfEl) srcProfEl.textContent = `Profile ID · ${localDeviceId.slice(0, 8)}`;

// Hook route changes for dynamic data pre-fetching
onRouteChanged((sectionId) => {
  if (sectionId === "storageSection" && !window._sharedFilesLoaded) {
    fetchDirectory().catch(showDirectoryError);
  }
  if (sectionId === "storageMgrSection") {
    refreshStorageInfo();
  }
  if (sectionId === "devicesSection" || sectionId === "transfersSection") {
    refreshDevices();
  }
  if (sectionId === "networkSection") {
    refreshNetworkInfo();
  }
});

// Quick QR shortcut handler
document.getElementById("quickQrBtn")?.addEventListener("click", () => {
  navigateTo("networkSection", true);
  document.getElementById("showPairQrBtn")?.click();
});

// Initial boot fetch
fetchDirectory().catch(showDirectoryError);
refreshDevices();
refreshNetworkInfo();

// Periodic polling
setInterval(() => { if (!document.hidden) refreshDevices(); }, 5000);
setInterval(() => { if (!document.hidden) refreshNetworkInfo(); }, 30000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshDevices();
    refreshNetworkInfo();
  }
});
