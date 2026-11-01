// static/js/services/transfer.js
// Chunked streaming, resumption, verification, and cancellation engine

import { safeStorage, sha256Buf, responseError } from "./utils.js";
import { localDeviceId, deviceHeaders } from "./device.js";

export let activeUpload = { id: null, resumeKey: null };

export function cancelActiveSession() {
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

export const relPath = file => file._relativePath || file.webkitRelativePath || file.name;

export async function filesFromDataTransfer(dt) {
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

export const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("Aborted", "AbortError")); }, { once: true });
});

export const backoff = n => Math.min(30000, 1000 * 2 ** n) * (0.5 + Math.random() / 2);

export const isRetryable = e => e.network || [408, 422, 425, 429, 500, 502, 503, 504].includes(e.status);

export async function waitForHost(signal) {
  for (let i = 0; ; i++) {
    signal?.throwIfAborted();
    const probe = new AbortController();
    const timer = setTimeout(() => probe.abort(), 4000);
    const relay = () => probe.abort();
    signal?.addEventListener("abort", relay, { once: true });
    try {
      if ((await fetch("/api/network", { cache: "no-store", signal: probe.signal })).ok) return;
    } catch (_) {
      // Host unreachable
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", relay);
    }
    await sleep(Math.min(5000, 500 * 2 ** i), signal);
  }
}

export async function postCreate(body, headers, signal, onWait) {
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

export async function finishTransfer(session, headers, signal, onProgress = () => {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(`/api/transfers/${session.id}/complete`, {
        method: "POST", headers, credentials: "same-origin", signal, body: "{}"
      });
      if (r.status === 202) {
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

export function putChunk(url, body, headers, signal, onProgress) {
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

export async function sendChunks({ session, file, offsets, chunkSize, signal, onBytes, onStatus = () => {} }) {
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

