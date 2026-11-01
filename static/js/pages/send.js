// static/js/pages/send.js
// Choose what to send: file/folder input, drag & drop, paste, serialized batches, collision handling, progress UI

import { safeStorage, formatBytes, formatDuration, showNotice, friendlyError, actionDialog, responseError, editText } from "../services/utils.js";
import { localDeviceId, deviceHeaders, setConnectionState, localDeviceName, setLocalDeviceName } from "../services/device.js";
import { relPath, filesFromDataTransfer, cancelActiveSession, setActiveUpload, clearActiveUpload, postCreate, sendChunks, finishTransfer } from "../services/transfer.js";
import { currentPath, fetchDirectory } from "./explorer.js";
import { refreshDevices } from "./devices.js";
import { navigateTo } from "../services/router.js";
import { createQueueController } from "../services/queue.js";
import { trackTransfer } from "../services/hud.js";

export let uploadInProgress = false;

const JUNK_FILE_RE = /^(\.DS_Store|Thumbs\.db|desktop\.ini|\._.*|~\$.*|.*\.crdownload)$/i;

export function sanitizeUploadFiles(rawFiles) {
  const all = Array.from(rawFiles || []);
  const kept = all.filter(file => !relPath(file).replace(/\\/g, "/").split("/")
    .some(p => JUNK_FILE_RE.test(p) || p.startsWith(".supershare-") || p.endsWith(".partial")));
  const dropped = all.length - kept.length;
  if (dropped) {
    showNotice(`${dropped} system or in-progress file(s) were skipped (.DS_Store, Thumbs.db, ~$ lock files, .crdownload).`, "info");
  }
  return kept;
}

const pendingBatches = [];
let currentAbort = null;
let queueCtl = null;
let hideTimer = 0;
const UPLOAD_CONCURRENCY = 3;
let dialogChain = Promise.resolve();
const serialDialog = run => {
  const result = dialogChain.then(run, run);
  dialogChain = result.catch(() => {});
  return result;
};

const uploadQueue = () => (queueCtl ||= createQueueController(document.getElementById("uploadQueue")));

function addRow(file, relative, base) {
  const row = document.createElement("li");
  const fileName = document.createElement("span");
  fileName.className = "upload-queue-name";
  fileName.textContent = `${relative} · ${formatBytes(file.size)}`;
  fileName.title = relative;
  const state = document.createElement("span");
  state.className = "upload-queue-state";
  state.setAttribute("aria-live", "polite");
  const progress = document.createElement("progress");
  progress.max = file.size || 1;
  progress.value = 0;
  row.append(fileName, state, progress);
  document.getElementById("uploadQueue").appendChild(row);
  const entry = { row, state, progress, relative, file, base };
  setRow(entry, "Queued", "");
  return entry;
}

function setRow(entry, text, kind = "") {
  entry.state.textContent = text;
  entry.state.className = `upload-queue-state ${kind}`.trim();
  entry.progress.hidden = ["failed", "cancelled", "skipped"].includes(kind);
  entry.progress.setAttribute("aria-label", `${entry.relative}: ${text}`);
  uploadQueue().setState(entry.row, kind === "" || kind === "running" ? "active" : kind);
}

export function enqueueUpload(files, base = currentPath) {
  const list = Array.from(files || []);
  if (!list.length) return;
  navigateTo("sendSection", true);
  const entries = list.map(file => addRow(file, relPath(file), base));
  pendingBatches.push({ entries });
  if (uploadInProgress) {
    showNotice(`${list.length} file(s) queued behind the current transfer.`, "info");
    return;
  }
  drain();
}
export const uploadFiles = enqueueUpload;

async function drain() {
  uploadInProgress = true;
  try {
    while (pendingBatches.length) await uploadBatch(pendingBatches.shift());
  } finally {
    uploadInProgress = false;
  }
}

async function uploadOne(entry, destination, signal, ui) {
  const { file, relative } = entry;
  const tracker = trackTransfer({ kind: "upload", label: relative });
  let outcome = "failed", sessionId = null;
  try {
    const headers = { "Content-Type": "application/json", ...deviceHeaders() };
    const stamp = `${localDeviceId}:${destination}:${file.name}:${file.size}:${file.lastModified}`;
    const resumeKey = `supershare-transfer:${stamp}`;
    const resumeId = safeStorage.getItem(resumeKey) || "";
    let collision = "ask";

    let created = await postCreate({
      name: file.name, size: file.size, path: destination, resume_id: resumeId, collision
    }, headers, signal, ui.speed);

    if (created.status === 409) {
      collision = await serialDialog(() => actionDialog({
        title: "Destination file already exists",
        message: `${destination}\n\nChoose how to handle the existing file. Replacing publishes the incoming file only after its chunks verify.`,
        actions: [
          { label: "Cancel", value: "cancel" },
          { label: "Skip", value: "skip" },
          { label: "Keep both", value: "rename" },
          { label: "Replace after verify", value: "replace", primary: true }
        ]
      })) || "cancel";
      if (collision === "cancel") {
        setRow(entry, "Cancelled", "cancelled");
        outcome = "cancelled";
        return "cancelled";
      }
      created = await postCreate({ name: file.name, size: file.size, path: destination, collision },
        headers, signal, ui.speed);
    }
    if (!created.ok) {
      throw Object.assign(new Error(await responseError(created)), { status: created.status });
    }

    const session = await created.json();
    if (session.status === "skipped") {
      setRow(entry, "Skipped", "skipped");
      outcome = "skipped";
      return "skipped";
    }
    if (session.status === "completed") {
      safeStorage.removeItem(resumeKey);
      entry.progress.value = entry.progress.max;
      setRow(entry, "Completed", "complete");
      outcome = "complete";
      return "complete";
    }

    safeStorage.setItem(resumeKey, session.id);
    safeStorage.setItem(`supershare-transfer-time:${stamp}`, String(Date.now()));
    sessionId = session.id; setActiveUpload(session.id, resumeKey);

    const chunkSize = session.chunk_size || (4 * 1024 * 1024);
    let uploadedBytes = session.offset || 0;
    entry.progress.value = Math.min(uploadedBytes, file.size || 1);
    setRow(entry, "Transferring", "running");

    const offsets = [];
    for (let pos = uploadedBytes; pos < file.size; pos += chunkSize) offsets.push(pos);

    let lastT = Date.now(), lastB = uploadedBytes, ema = 0;
    const render = () => {
      const now = Date.now();
      if (now - lastT >= 1000) {
        const inst = Math.max(0, uploadedBytes - lastB) / ((now - lastT) / 1000);
        ema = ema ? ema * 0.7 + inst * 0.3 : inst;
        lastT = now;
        lastB = uploadedBytes;
      }
      const pct = file.size ? Math.min(100, Math.round(uploadedBytes / file.size * 100)) : 100;
      const eta = ema > 0 ? ` · ETA ${formatDuration((file.size - uploadedBytes) / ema)}` : "";
      ui.progress(pct);
      entry.progress.value = Math.min(uploadedBytes, file.size || 1);
      ui.speed(`${formatBytes(uploadedBytes)} / ${formatBytes(file.size)} · ${formatBytes(ema)}/s${eta}`);
      entry.state.textContent = `${pct}% · ${formatBytes(ema)}/s${eta}`;
      tracker.update({ done: uploadedBytes, total: file.size, rate: ema });
    };

    await sendChunks({
      session, file, offsets, chunkSize, signal,
      onBytes: d => { uploadedBytes += d; render(); },
      onStatus: ui.speed
    });

    ui.name(`Verifying ${file.name}`);
    setRow(entry, "Verifying", "running");
    ui.speed("Verifying chunks and final file checksum");

    let completed = await finishTransfer(session, headers, signal, (verified, total) => {
      ui.speed(`Verifying ${formatBytes(verified)} of ${formatBytes(total)}`);
    });
    for (let pass = 0; completed.error === "chunks_corrupt" && pass < 3; pass++) {
      showNotice(`Repairing ${completed.bad_offsets.length} damaged chunk(s)...`, "info");
      await sendChunks({
        session, file, offsets: completed.bad_offsets, chunkSize, signal,
        onBytes: () => {}, onStatus: ui.speed
      });
      completed = await finishTransfer(session, headers, signal);
    }
    if (completed.error) {
      throw new Error("The laptop could not verify this file after re-sending damaged chunks.");
    }

    safeStorage.removeItem(resumeKey);
    entry.progress.value = entry.progress.max;
    setRow(entry, "Completed", "complete");
    outcome = "complete";
    return "complete";
  } catch (error) {
    outcome = error.name === "AbortError" ? "cancelled" : "failed";
    throw error;
  } finally {
    clearActiveUpload(sessionId);
    tracker.finish(outcome);
  }
}

async function uploadBatch({ entries }) {
  const box = document.getElementById("progressContainer");
  const name = document.getElementById("uploadFileName");
  const bar = document.getElementById("uploadBarFill");
  const percent = document.getElementById("uploadPercent");
  const speed = document.getElementById("uploadSpeed");
  const cancelBtn = document.getElementById("cancelUploadBtn");
  const indicator = document.querySelector(".running-indicator");
  const setText = (el, text) => { if (el) el.textContent = text; };

  clearTimeout(hideTimer);
  box?.classList.remove("hidden");
  cancelBtn?.classList.remove("hidden");
  indicator?.classList.remove("complete", "failed");
  currentAbort = new AbortController();
  const signal = currentAbort.signal;

  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch (_) {}

  let skipped = 0, cancelled = 0, finished = 0;
  const failed = [];
  const totalBytes = entries.reduce((sum, entry) => sum + (entry.file.size || 0), 0) || 1;
  const startedAt = Date.now();
  const concurrency = entries.length > 1 && entries.some(entry => entry.file.size < 16 * 1024 * 1024)
    ? UPLOAD_CONCURRENCY : 1;

  const paint = () => {
    const done = entries.reduce((sum, entry) => sum + (Number(entry.progress.value) || 0), 0);
    const pct = Math.min(100, Math.round(done / totalBytes * 100));
    const avg = done / Math.max(1, (Date.now() - startedAt) / 1000);
    if (bar) bar.style.width = `${pct}%`;
    setText(percent, `${pct}%`);
    setText(speed, `${formatBytes(done)} / ${formatBytes(totalBytes)} · ${formatBytes(avg)}/s average`);
    setText(name, `Uploading: ${finished} of ${entries.length} files finished`);
  };

  setConnectionState(`Sending ${entries.length} file${entries.length === 1 ? "" : "s"}`, "online");
  const ticker = setInterval(paint, 500);
  paint();

  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const entry = entries[next++];
      if (signal.aborted) {
        setRow(entry, "Not started · cancelled", "cancelled");
        cancelled++;
        finished++;
        continue;
      }
      const destination = entry.base ? `${entry.base}/${entry.relative}` : entry.relative;
      const ui = { name: () => {}, progress: () => {}, speed: text => { entry.state.textContent = text; } };
      setRow(entry, "Preparing", "running");
      try {
        const result = await uploadOne(entry, destination, signal, ui);
        if (result === "skipped") skipped++;
        else if (result === "cancelled") cancelled++;
      } catch (error) {
        if (error.name === "AbortError") {
          setRow(entry, "Cancelled", "cancelled");
          cancelled++;
        } else {
          failed.push(entry);
          setRow(entry, `Failed · ${friendlyError(error)}`, "failed");
          uploadQueue().setRetry(entry.row, () => enqueueUpload([entry.file], entry.base));
        }
      }
      finished++;
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
    const ok = entries.length - skipped - cancelled - failed.length;
    paint();
    setText(name, signal.aborted ? "Transfer cancelled" : `Completed ${ok}; skipped ${skipped}; failed ${failed.length}`);
    if (!signal.aborted && bar) { bar.style.width = "100%"; setText(percent, "100%"); }
    indicator?.classList.add(failed.length || signal.aborted ? "failed" : "complete");
    setConnectionState(signal.aborted ? "Transfer cancelled" : "Batch transfer finished", "online");
    showNotice(`Sent ${ok}; skipped ${skipped}; cancelled ${cancelled}; failed ${failed.length}.`,
      failed.length ? "error" : "success");
    fetchDirectory(currentPath).catch(() => {});
    refreshDevices();
  } finally {
    clearInterval(ticker);
    try { await wakeLock?.release(); } catch (_) {}
    cancelBtn?.classList.add("hidden");
    currentAbort = null;
    if (!failed.length && !pendingBatches.length) {
      hideTimer = setTimeout(() => box?.classList.add("hidden"), 6000);
    }
  }
}

export function initSendPage() {
  uploadQueue();

  document.getElementById("cancelUploadBtn")?.addEventListener("click", () => {
    pendingBatches.splice(0).forEach(batch =>
      batch.entries.forEach(entry => setRow(entry, "Cancelled before it started", "cancelled")));
    currentAbort?.abort();
    cancelActiveSession();
  });

  document.getElementById("fileInput")?.addEventListener("change", event => {
    const files = sanitizeUploadFiles(event.target.files);
    event.target.value = "";
    if (files.length) enqueueUpload(files);
  });
  document.getElementById("folderInput")?.addEventListener("change", event => {
    const files = sanitizeUploadFiles(event.target.files);
    event.target.value = "";
    if (files.length) enqueueUpload(files);
  });

  const dropZone = document.getElementById("dropZone");
  if (dropZone) {
    dropZone.addEventListener("dragover", event => {
      event.preventDefault();
      dropZone.classList.add("drag-active");
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-active"));
    dropZone.addEventListener("drop", async event => {
      event.preventDefault();
      dropZone.classList.remove("drag-active");
      const files = sanitizeUploadFiles(await filesFromDataTransfer(event.dataTransfer));
      if (files.length) enqueueUpload(files);
    });
  }

  document.addEventListener("paste", event => {
    if (event.target?.closest?.("input, textarea")) return;
    const files = sanitizeUploadFiles(event.clipboardData?.files);
    if (files.length) enqueueUpload(files);
  });

  document.getElementById("nameBrowserBtn")?.addEventListener("click", async () => {
    const name = await editText("Name this profile", "Give this browser profile a recognizable name:", "Display name", localDeviceName);
    if (!name) return;
    setLocalDeviceName(name);
    refreshDevices();
  });
}
