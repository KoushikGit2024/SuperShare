// static/js/pages/connect.js
// Step 1: Network connectivity, Wi-Fi / Hotspot address detection, TLS fingerprint, and QR pairing

import { showNotice, responseError, formatBytes } from "../services/utils.js";
import { localDeviceId } from "../services/device.js";

export let preferredConnectionUrl = "";
export let networkTlsEnabled = false;
export let pairingCodeFromQr = new URLSearchParams(location.search).get("pair_code");

export async function refreshNetworkInfo() {
  const addresses = document.getElementById("networkAddresses");
  const status = document.getElementById("networkStatus");
  if (!addresses || !status) return;

  try {
    const response = await fetch("/api/network", { cache: "no-store" });
    if (!response.ok) throw new Error(await responseError(response));
    const info = await response.json();
    networkTlsEnabled = info.scheme === "https";

    const connection = info.connection;
    preferredConnectionUrl = connection?.url || "";
    addresses.replaceChildren();

    if (info.interfaces?.length) {
      info.interfaces.forEach(item => {
        const portPart = info.port && ![80, 443].includes(info.port) ? `:${info.port}` : "";
        const url = `${info.scheme}://${item.address}${portPart}/`;
        const row = document.createElement("div");
        row.className = `network-row ${item.address === connection?.address ? "preferred" : ""}`;
        const main = document.createElement("div");
        main.className = "network-row-main";
        const badge = document.createElement("span");
        badge.className = "network-badge";
        badge.textContent = item.kind || "Local";
        const code = document.createElement("code");
        code.textContent = url;
        const name = document.createElement("span");
        name.className = "network-ifname";
        name.textContent = item.name;
        main.append(badge, code, name);
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "btn-xs outline";
        copy.textContent = "Copy";
        copy.onclick = async () => {
          try {
            await navigator.clipboard.writeText(url);
            showNotice("Address copied. Open it on a device connected to this hotspot.", "success");
          } catch (_) {
            showNotice("Could not copy the address.", "error");
          }
        };
        row.append(main, copy);
        addresses.appendChild(row);
      });
    } else {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No hotspot or local network address detected. Turn on your laptop hotspot or connect to Wi-Fi.";
      addresses.appendChild(empty);
    }

    const copyBtn = document.getElementById("copyConnectionBtn");
    if (copyBtn) copyBtn.disabled = !preferredConnectionUrl;

    const qrBtn = document.getElementById("showPairQrBtn");
    if (qrBtn) qrBtn.disabled = !preferredConnectionUrl;

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
      ? `${connection.kind} ready · Instant sharing enabled · Internet not required${extra}`
      : `SuperShare is running on this laptop, but no Wi-Fi / hotspot address is available${extra}`;
    status.classList.remove("error");
    status.classList.toggle("attention", !connection);
  } catch (error) {
    status.textContent = `Connection diagnostics unavailable: ${error.message}`;
    status.classList.remove("attention");
    status.classList.add("error");
  }
}

export function initConnectPage() {
  document.getElementById("copyConnectionBtn")?.addEventListener("click", async () => {
    try {
      if (!preferredConnectionUrl) await refreshNetworkInfo();
      if (!preferredConnectionUrl) throw new Error("Turn on the laptop hotspot or connect this laptop to Wi-Fi first.");
      await navigator.clipboard.writeText(preferredConnectionUrl);
      showNotice("Connection address copied. Open it on a device connected to this hotspot.", "success");
    } catch (_) {
      showNotice("Could not copy connection address. Select and copy it from the Network section.", "error");
    }
  });

  document.getElementById("showPairQrBtn")?.addEventListener("click", async () => {
    try {
      const panel = document.getElementById("pairQrPanel");
      const toggle = document.getElementById("showPairQrBtn");
      if (!panel.classList.contains("hidden")) {
        panel.classList.add("hidden");
        toggle.setAttribute("aria-expanded", "false");
        toggle.textContent = "Show pairing QR";
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
      toggle.setAttribute("aria-expanded", "true");
      toggle.textContent = "Hide pairing QR";
    } catch (error) {
      showNotice(error.message, "error");
    }
  });

  document.getElementById("hidePairQrBtn")?.addEventListener("click", () => {
    document.getElementById("pairQrPanel").classList.add("hidden");
    const toggle = document.getElementById("showPairQrBtn");
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "Show pairing QR";
  });

  document.getElementById("copyPairingUrlBtn")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(document.getElementById("pairingUrlText").textContent);
      showNotice("Pairing link copied. Open it on a device connected to this hotspot.", "success");
    } catch (_) {
      showNotice("Could not copy the pairing link.", "error");
    }
  });

  document.getElementById("copyTlsFingerprintBtn")?.addEventListener("click", async () => {
    try {
      const response = await fetch("/api/network", { cache: "no-store" });
      const info = await response.json();
      await navigator.clipboard.writeText(info.ca_fingerprint || "");
      showNotice("TLS CA fingerprint copied. Compare it with the value printed in the host terminal.", "success");
    } catch (_) {
      showNotice("Could not copy the TLS fingerprint.", "error");
    }
  });
}

