// static/js/pages/send.js
// Step 2: Choose what to send, file input, folder input, drag & drop, paste, collision handling, progress UI

import { safeStorage, formatBytes, formatDuration, showNotice, friendlyError, actionDialog, responseError, editText } from "../services/utils.js";
import { localDeviceId, deviceHeaders, setConnectionState, localDeviceName, setLocalDeviceName } from "../services/device.js";
import { relPath, filesFromDataTransfer, cancelActiveSession, setActiveUpload, clearActiveUpload, postCreate, sendChunks, finishTransfer } from "../services/transfer.js";
import { currentPath, fetchDirectory } from "./explorer.js";
import { refreshDevices } from "./devices.js";
import { navigateTo } from "../services/router.js";

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

export async function uploadFiles(files, retryName = null) {
  if (!files.length) return;
  navigateTo("sendSection", true);

  const box = document.getElementById("progressContainer");
  const name = document.getElementById("uploadFileName");
  const bar = document.getElementById("uploadBarFill");
  const percent = document.getElementById("uploadPercent");
  const speed = document.getElementById("uploadSpeed");
  const queue = document.getElementById("uploadQueue");
  const cancelBtn = document.getElementById("cancelUploadBtn");

  box?.classList.remove("hidden");
  cancelBtn?.classList.remove("hidden");
  document.querySelector(".running-indicator")?.classList.remove("complete", "failed");

  uploadInProgress = true;
  const uploadAbort = new AbortController();
  if (cancelBtn) {
    cancelBtn.onclick = () => {
      uploadAbort.abort();
      cancelActiveSession();
    };
  }

  let wakeLock = null;
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch (_) {}

  let skippedFiles = 0;
  const failedFiles = [];

  setConnectionState(`Sending ${files.length} file${files.length === 1 ? "" : "s"}`, "online");
  queue?.replaceChildren();
  queue?.classList.remove("hidden");

  const queueEntries = Array.from(files, (file, index) => {
    const relative = retryName || relPath(file);
    const row = document.createElement("li");
    const fileName = document.createElement("span");
    fileName.className = "upload-queue-name";
    fileName.textContent = `${index + 1}. ${relative} · ${formatBytes(file.size)}`;
    const state = document.createElement("span");
    state.className = "upload-queue-state";
    state.textContent = "Queued";
    state.setAttribute("aria-live", "polite");
    const progress = document.createElement("progress");
    progress.max = file.size || 1;
    progress.value = 0;
    progress.setAttribute("aria-label", `${relative}: queued`);
    row.append(fileName, state, progress);
    queue?.appendChild(row);
    return { state, progress, relative };
  });

  try {
    for (let index = 0; index < files.length; index++) {
      uploadAbort.signal.throwIfAborted();
      const file = files[index];
      const relative = retryName || relPath(file);
      const destination = retryName ? retryName : (currentPath ? `${currentPath}/${relative}` : relative);
      const queueEntry = queueEntries[index];

      queueEntry.state.textContent = "Preparing";
      queueEntry.state.className = "upload-queue-state running";
      if (name) name.textContent = `Uploading ${index + 1} of ${files.length}: ${relative}`;
      if (bar) bar.style.width = "0%";
      if (percent) percent.textContent = "0%";
      if (speed) speed.textContent = "Starting";

      try {
        await new Promise((resolve, reject) => {
          (async () => {
            const start = Date.now();
            const headers = { "Content-Type": "application/json", ...deviceHeaders() };
            const resumeKey = `supershare-transfer:${localDeviceId}:${destination}:${file.name}:${file.size}:${file.lastModified}`;
            const resumeId = safeStorage.getItem(resumeKey) || "";
            let collision = "ask";

            let created = await postCreate({
              name: file.name, size: file.size, path: destination, resume_id: resumeId, collision
            }, headers, uploadAbort.signal, t => { if (speed) speed.textContent = t; });

            if (created.status === 409) {
              collision = await actionDialog({
                title: "Destination file already exists",
                message: `${destination}\n\nChoose how to handle the existing file. Replacing publishes the incoming file only after its chunks verify.`,
                actions: [
                  { label: "Cancel", value: "cancel" },
                  { label: "Skip", value: "skip" },
                  { label: "Keep both", value: "rename" },
                  { label: "Replace after verify", value: "replace", primary: true }
                ]
              }) || "cancel";

              if (collision === "cancel") {
                skippedFiles++;
                queueEntry.state.textContent = "Cancelled";
                queueEntry.state.className = "upload-queue-state";
                resolve();
                return;
              }
              created = await postCreate({
                name: file.name, size: file.size, path: destination, collision
              }, headers, uploadAbort.signal, t => { if (speed) speed.textContent = t; });
            }

            if (!created.ok) {
              throw Object.assign(new Error(await responseError(created)), { status: created.status });
            }

            const session = await created.json();
            if (session.status === "skipped") {
              skippedFiles++;
              queueEntry.state.textContent = "Skipped";
              queueEntry.state.className = "upload-queue-state";
              resolve();
              return;
            }
            if (session.status === "completed") {
              safeStorage.removeItem(resumeKey);
              queueEntry.state.textContent = "Completed";
              queueEntry.state.className = "upload-queue-state complete";
              queueEntry.progress.value = queueEntry.progress.max;
              resolve();
              return;
            }

            safeStorage.setItem(resumeKey, session.id);
            safeStorage.setItem(`supershare-transfer-time:${localDeviceId}:${destination}:${file.name}:${file.size}:${file.lastModified}`, String(Date.now()));
            setActiveUpload(session.id, resumeKey);

            let offset = session.offset || 0;
            const chunkSize = session.chunk_size || (4 * 1024 * 1024);
            let uploadedBytes = offset;

            queueEntry.progress.value = Math.min(uploadedBytes, file.size || 1);
            queueEntry.state.textContent = "Transferring";

            const chunkOffsets = [];
            for (let pos = offset; pos < file.size; pos += chunkSize) {
              chunkOffsets.push(pos);
            }

            let lastT = start, lastB = uploadedBytes, ema = 0;
            const render = () => {
              const now = Date.now();
              if (now - lastT >= 1000) {
                const inst = Math.max(0, uploadedBytes - lastB) / ((now - lastT) / 1000);
                ema = ema ? ema * 0.7 + inst * 0.3 : inst;
                lastT = now;
                lastB = uploadedBytes;
              }
              const pct = file.size ? Math.min(100, Math.round(uploadedBytes / file.size * 100)) : 100;
              const rate = ema;
              const eta = rate > 0 ? ` · ETA ${formatDuration((file.size - uploadedBytes) / rate)}` : "";
              if (bar) bar.style.width = `${pct}%`;
              if (percent) percent.textContent = `${pct}%`;
              queueEntry.progress.value = Math.min(uploadedBytes, file.size || 1);
              if (speed) speed.textContent = `${formatBytes(uploadedBytes)} / ${formatBytes(file.size)} · ${formatBytes(rate)}/s${eta}`;
              queueEntry.state.textContent = `${pct}% · ${formatBytes(rate)}/s${eta}`;
            };

            await sendChunks({
              session, file, offsets: chunkOffsets, chunkSize, signal: uploadAbort.signal,
              onBytes: d => { uploadedBytes += d; render(); },
              onStatus: s => { if (speed) speed.textContent = s; }
            });

            if (name) name.textContent = `Verifying ${file.name}`;
            queueEntry.state.textContent = "Verifying";
            if (speed) speed.textContent = "Verifying chunks and final file checksum";

            let completed = await finishTransfer(session, headers, uploadAbort.signal, (verified, total) => {
              if (speed) speed.textContent = `Verifying ${formatBytes(verified)} of ${formatBytes(total)}`;
            });

            for (let pass = 0; completed.error === "chunks_corrupt" && pass < 3; pass++) {
              showNotice(`Repairing ${completed.bad_offsets.length} damaged chunk(s)...`, "info");
              await sendChunks({
                session, file, offsets: completed.bad_offsets, chunkSize, signal: uploadAbort.signal,
                onBytes: () => {}, onStatus: s => { if (speed) speed.textContent = s; }
              });
              completed = await finishTransfer(session, headers, uploadAbort.signal);
            }

            if (completed.error) {
              throw new Error("The laptop could not verify this file after re-sending damaged chunks.");
            }

            safeStorage.removeItem(resumeKey);
            queueEntry.state.textContent = "Completed";
            queueEntry.state.className = "upload-queue-state complete";
            queueEntry.progress.value = queueEntry.progress.max;
            resolve();
          })().catch(reject);
        });
        clearActiveUpload();
      } catch (fileErr) {
        clearActiveUpload();
        if (fileErr.name === "AbortError") throw fileErr;
        failedFiles.push(relative);
        queueEntry.state.textContent = `Failed · ${friendlyError(fileErr)}`;
        queueEntry.state.className = "upload-queue-state failed";
        continue;
      }
    }

    const successCount = files.length - skippedFiles - failedFiles.length;
    if (name) name.textContent = `Completed ${successCount}; skipped ${skippedFiles}; failed ${failedFiles.length}`;
    if (percent) percent.textContent = "100%";
    if (bar) bar.style.width = "100%";
    document.querySelector(".running-indicator")?.classList.add(failedFiles.length ? "failed" : "complete");
    setConnectionState("Batch transfer finished", "online");
    showNotice(`Sent ${successCount}; skipped ${skippedFiles}; failed ${failedFiles.length}.`, failedFiles.length ? "error" : "success");
    fetchDirectory(currentPath);
    refreshDevices();
  } catch (err) {
    if (name) name.textContent = err.name === "AbortError" ? "Transfer cancelled" : "Transfer failed";
    queueEntries.forEach(entry => {
      if (entry.state.textContent === "Queued") entry.state.textContent = "Not started · cancelled/aborted";
    });
    document.querySelector(".running-indicator")?.classList.add("failed");
    setConnectionState(friendlyError(err), "error");
    showNotice(friendlyError(err), "error");
    refreshDevices();
  } finally {
    wakeLock?.release();
    if (cancelBtn) cancelBtn.classList.add("hidden");
    uploadInProgress = false;
  }
}

export function initSendPage() {
  document.getElementById("fileInput")?.addEventListener("change", event => {
    const files = sanitizeUploadFiles(event.target.files);
    event.target.value = "";
    if (files.length) uploadFiles(files);
  });

  document.getElementById("folderInput")?.addEventListener("change", event => {
    const files = sanitizeUploadFiles(event.target.files);
    event.target.value = "";
    if (files.length) uploadFiles(files);
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
      if (files.length) uploadFiles(files);
    });
  }

  document.addEventListener("paste", event => {
    const files = sanitizeUploadFiles(event.clipboardData?.files);
    if (files.length) uploadFiles(files);
  });

  document.getElementById("nameBrowserBtn")?.addEventListener("click", async () => {
    const name = await editText("Name this profile", "Give this browser profile a recognizable name:", "Display name", localDeviceName);
    if (!name) return;
    setLocalDeviceName(name);
    refreshDevices();
  });
}

