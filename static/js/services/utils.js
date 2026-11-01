// static/js/services/utils.js
// Safe storage, formatting, DOM helpers, notice banner, and accessible action dialogs

export const safeStorage = {
  getItem(k) {
    try {
      return localStorage.getItem(k);
    } catch (_) {
      return this[k] || null;
    }
  },
  setItem(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch (_) {
      this[k] = String(v);
    }
  },
  removeItem(k) {
    try {
      localStorage.removeItem(k);
    } catch (_) {
      delete this[k];
    }
  },
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

const SHA_K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Js(buffer) {
  const data = new Uint8Array(buffer);
  const H = new Int32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const W = new Int32Array(64);
  const len = data.length;
  const body = len - (len % 64);
  const tail = new Uint8Array(len % 64 < 56 ? 64 : 128);
  tail.set(data.subarray(body));
  tail[len % 64] = 0x80;
  const view = new DataView(tail.buffer);
  view.setUint32(tail.length - 8, Math.floor(len / 0x20000000));
  view.setUint32(tail.length - 4, (len << 3) >>> 0);

  const compress = (src, off) => {
    for (let i = 0; i < 16; i++) {
      const j = off + (i << 2);
      W[i] = (src[j] << 24) | (src[j + 1] << 16) | (src[j + 2] << 8) | src[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15],
        y = W[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = H[0],
      b = H[1],
      c = H[2],
      d = H[3],
      e = H[4],
      f = H[5],
      g = H[6],
      h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + SHA_K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0;
    H[1] = (H[1] + b) | 0;
    H[2] = (H[2] + c) | 0;
    H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0;
    H[5] = (H[5] + f) | 0;
    H[6] = (H[6] + g) | 0;
    H[7] = (H[7] + h) | 0;
  };

  for (let off = 0; off < body; off += 64) compress(data, off);
  for (let off = 0; off < tail.length; off += 64) compress(tail, off);
  return Array.from(H, (v) => (v >>> 0).toString(16).padStart(8, "0")).join("");
}

export async function sha256Buf(buffer) {
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  await new Promise((resolve) => setTimeout(resolve, 0)); // let the UI paint before a long synchronous hash
  return sha256Js(buffer);
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
  close.onclick = () => {
    clearTimeout(showNotice.timer);
    notice.classList.add("hidden");
  };
  notice.replaceChildren(text, close);
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(
    () => notice.classList.add("hidden"),
    type === "error" ? 12000 : 5000
  );
}

export function actionDialog({ title, message, inputLabel = "", inputValue = "", actions = [] }) {
  const dialog = document.getElementById("actionDialog");
  if (!dialog?.showModal) {
    showNotice(
      "This browser does not support the action dialog. Update browser and try again.",
      "error"
    );
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
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onClose = () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    };
    dialog.addEventListener("close", onClose, { once: true });
    const form = dialog.querySelector("form");
    form.onsubmit = (event) => event.preventDefault();
    input.onkeydown = (event) => {
      if (event.key === "Enter" && inputLabel) {
        event.preventDefault();
        actionList.querySelector("button:last-child")?.click();
      }
    };
    actions.forEach((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action.danger
        ? "btn-sm danger"
        : action.primary
          ? "btn-sm accent"
          : "btn-sm outline";
      button.textContent = action.label;
      button.addEventListener("click", () =>
        finish(action.cancel ? null : inputLabel ? input.value.trim() || null : action.value)
      );
      actionList.appendChild(button);
    });
    dialog.showModal();
    (inputLabel ? input : actionList.querySelector("button:last-child"))?.focus();
  });
}

export function confirmAction(title, message, danger = false) {
  return actionDialog({
    title,
    message,
    actions: [
      { label: "Keep current", value: false },
      { label: "Continue", value: true, primary: !danger, danger },
    ],
  });
}

export function editText(title, message, label, value = "") {
  return actionDialog({
    title,
    message,
    inputLabel: label,
    inputValue: value,
    actions: [
      { label: "Cancel", value: null, cancel: true },
      { label: "Save", value: true, primary: true },
    ],
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
  return Boolean(
    list && (list.contains(document.activeElement) || list.querySelector("details[open]"))
  );
}

export function friendlyError(e) {
  if (e.name === "AbortError") return "Cancelled";
  const looksOffline =
    e.network || (e instanceof TypeError && /fetch|network|load failed/i.test(e.message || ""));
  if (looksOffline)
    return "Lost connection to the laptop. Check both devices are on the same hotspot and mobile data isn't taking over, then select the file again to resume.";
  if (e instanceof TypeError) return `Browser error: ${e.message}`;
  if (["NotReadableError", "NotFoundError"].includes(e.name))
    return "The browser can no longer read this file (moved, deleted or permission revoked).";
  if (e.status === 507) return "The laptop's receive drive is full.";
  if (e.status === 429)
    return "The host is already running its maximum number of transfers. Wait or cancel a stalled one.";
  if (e.status === 403) return "The host has not granted this browser send access.";
  if (e.status === 409) return `The host stopped this transfer: ${e.message}`;
  return e.message || "Unknown error";
}
