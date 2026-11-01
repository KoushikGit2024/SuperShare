// static/js/services/device.js
// Client device identification, persistent profile naming, and authorization state

import { safeStorage } from "./utils.js";

const deviceIdKey = "supershare_device_id";
// Migrate the legacy hyphenated key so existing pairings keep their identity.
export let localDeviceId =
  safeStorage.getItem(deviceIdKey) || safeStorage.getItem("supershare-device-id");
if (!localDeviceId) {
  localDeviceId = crypto.randomUUID
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
}
const cookieMatch = document.cookie.match(/(?:^|; )supershare_did=([A-Za-z0-9_-]{8,80})/);
if (!safeStorage.getItem(deviceIdKey) && cookieMatch) localDeviceId = cookieMatch[1];
safeStorage.setItem(deviceIdKey, localDeviceId);
document.cookie = `supershare_did=${localDeviceId}; max-age=31536000; path=/; samesite=lax`;

// Purge resume keys older than 7 days
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

const clientPlatform =
  navigator.userAgentData?.platform ||
  (/Android/i.test(navigator.userAgent)
    ? "Android"
    : /iPhone|iPad/i.test(navigator.userAgent)
      ? "iOS"
      : /Win/i.test(navigator.platform)
        ? "Windows"
        : /Mac/i.test(navigator.platform)
          ? "macOS"
          : "Browser");

const browserName =
  /EdgA?\//.test(navigator.userAgent) || /EdgiOS\//.test(navigator.userAgent)
    ? "Edge"
    : /OPR\//.test(navigator.userAgent)
      ? "Opera"
      : /FxiOS\//.test(navigator.userAgent) || /Firefox\//.test(navigator.userAgent)
        ? "Firefox"
        : /CriOS\//.test(navigator.userAgent) || /Chrome\//.test(navigator.userAgent)
          ? "Chrome"
          : /Safari\//.test(navigator.userAgent)
            ? "Safari"
            : "Web browser";

export function wellFormedText(value) {
  const text = String(value ?? "");
  let result = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) result += text[index] + text[++index];
      else result += "\uFFFD";
    } else if (code >= 0xdc00 && code <= 0xdfff) result += "\uFFFD";
    else result += text[index];
  }
  return result;
}

export let localDeviceName =
  wellFormedText(safeStorage.getItem("supershare-device-name")) ||
  `${clientPlatform} · ${browserName}`;
export const localDeviceType = `${clientPlatform} browser · ${browserName}`;

export function setLocalDeviceName(name) {
  localDeviceName = wellFormedText(name);
  safeStorage.setItem("supershare-device-name", localDeviceName);
  const srcEl = document.getElementById("sourceDeviceName");
  if (srcEl) srcEl.textContent = localDeviceName;
}

export function deviceHeaders() {
  return {
    "X-Device-Id": localDeviceId,
    "X-Device-Name": encodeURIComponent(localDeviceName),
    "X-Device-Platform": encodeURIComponent(localDeviceType),
  };
}

export function setConnectionState(text, type = "pending") {
  const el = document.getElementById("connectionState");
  if (!el) return;
  el.textContent = text;
  el.className = `connection-state ${type}`;
}
