// static/js/services/utils.js
// Safe storage, formatting, DOM helpers, notice banner, and accessible action dialogs

export const safeStorage = {
  getItem(k) { try { return localStorage.getItem(k); } catch (_) { return this[k] || null; } },
  setItem(k, v) { try { localStorage.setItem(k, v); } catch (_) { this[k] = String(v); } },
  removeItem(k) { try { localStorage.removeItem(k); } catch (_) { delete this[k]; } }
};

export function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return "0 B";
  const num = Number(bytes);
  if (num === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(Math.abs(num)) / Math.log(k));
  return (num / Math.pow(k, i)).toFixed(i ? 1 : 0) + " " + sizes[i];
}

export function formatDuration(seconds) {
  if (!seconds || seconds <= 0 || !isFinite(seconds)) return "0s";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return `${m}m ${remS}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export async function sha256Buf(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export function icon(name, className = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

export function showNotice(message, type = "info") {
  const notice = document.getElementById("notice");
  if (!notice) return;
  notice.className = `notice ${type}`;
  const text = document.createElement("span");
  text.className = "notice-text";
  text.textContent = message;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "notice-close";
  close.setAttribute("aria-label", "Dismiss message");
  close.textContent = "×";
  close.onclick = () => { clearTimeout(showNotice.timer); notice.classList.add("hidden"); };
  notice.replaceChildren(text, close);
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => notice.classList.add("hidden"), type === "error" ? 12000 : 5000);
}

export function actionDialog({ title, message, inputLabel = "", inputValue = "", actions = [] }) {
  const dialog = document.getElementById("actionDialog");
  if (!dialog?.showModal) {
    showNotice("This browser does not support the action dialog. Update browser and try again.", "error");
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
      if (event.key === "Enter" && inputLabel) {
        event.preventDefault();
        actionList.querySelector("button:last-child")?.click();
      }
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

export function confirmAction(title, message, danger = false) {
  return actionDialog({
    title, message,
    actions: [
      { label: "Keep current", value: false },
      { label: "Continue", value: true, primary: !danger, danger }
    ]
  });
}

export function editText(title, message, label, value = "") {
  return actionDialog({
    title, message, inputLabel: label, inputValue: value,
    actions: [
      { label: "Cancel", value: null, cancel: true },
      { label: "Save", value: true, primary: true }
    ]
  });
}

export async function responseError(response) {
  const text = await response.text();
  try {
    const data = JSON.parse(text);
    return data.message || data.error || text;
  } catch (_) {
    return text || `Request failed (${response.status})`;
  }
}

export function listBusy(list) {
  return Boolean(list && (list.contains(document.activeElement) || list.querySelector("details[open]")));
}

export function friendlyError(e) {
  if (e.name === "AbortError") return "Cancelled";
  if (e.network || e instanceof TypeError) return "Lost connection to the laptop. Check both devices are on the same hotspot and mobile data isn't taking over, then select the file again to resume.";
  if (["NotReadableError", "NotFoundError"].includes(e.name)) return "The browser can no longer read this file (moved, deleted or permission revoked).";
  if (e.status === 507) return "The laptop's receive drive is full.";
  if (e.status === 429) return "The host is already running its maximum number of transfers. Wait or cancel a stalled one.";
  if (e.status === 403) return "The host has not granted this browser send access.";
  if (e.status === 409) return `The host stopped this transfer: ${e.message}`;
  return e.message || "Unknown error";
}

