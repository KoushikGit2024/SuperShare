// static/js/services/preview.js
// Inline preview handler for images, audio, video, PDF, and code/text files

import { formatBytes, icon, safeStorage } from "./utils.js";

export const PREVIEW_TYPES = {
  img: new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "avif"]),
  video: new Set(["mp4", "webm", "ogg", "mov", "mkv"]),
  audio: new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac"]),
  pdf: new Set(["pdf"]),
  text: new Set([
    "txt",
    "md",
    "json",
    "py",
    "js",
    "html",
    "css",
    "csv",
    "log",
    "xml",
    "sh",
    "ps1",
    "yaml",
    "yml",
    "ini",
    "sql",
    "bat",
    "env",
    "ts",
  ]),
};

export function getFileExtension(filename) {
  const parts = String(filename || "").split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

export function canPreviewFile(filename) {
  const ext = getFileExtension(filename);
  return Object.values(PREVIEW_TYPES).some((set) => set.has(ext));
}

export async function openFilePreview(relPath, filename, size) {
  const modal = document.getElementById("previewModal");
  const title = document.getElementById("previewFileName");
  const content = document.getElementById("previewContent");
  const dlBtn = document.getElementById("previewDownloadBtn");

  if (!modal || !title || !content || !dlBtn) return;

  title.textContent = `${filename} (${formatBytes(size)})`;
  dlBtn.href = `/api/download?path=${encodeURIComponent(relPath)}`;
  dlBtn.dataset.downloadName = filename;
  content.replaceChildren();

  const previewUrl = `/api/preview?path=${encodeURIComponent(relPath)}`;
  const ext = getFileExtension(filename);

  if (PREVIEW_TYPES.img.has(ext)) {
    const img = document.createElement("img");
    img.className = "preview-img";
    img.src = previewUrl;
    img.alt = filename;
    img.loading = "lazy";
    content.appendChild(img);
  } else if (PREVIEW_TYPES.audio.has(ext)) {
    const wrap = document.createElement("div");
    wrap.className = "preview-audio-container";
    const audioIcon = icon("music", "preview-audio-icon");
    const audio = document.createElement("audio");
    audio.className = "preview-media";
    audio.controls = true;
    audio.autoplay = true;
    audio.src = previewUrl;
    wrap.append(audioIcon, audio);
    content.appendChild(wrap);
  } else if (PREVIEW_TYPES.video.has(ext)) {
    const video = document.createElement("video");
    video.className = "preview-media";
    video.controls = true;
    video.autoplay = true;
    video.src = previewUrl;
    content.appendChild(video);
  } else if (PREVIEW_TYPES.pdf.has(ext)) {
    const iframe = document.createElement("iframe");
    iframe.className = "preview-pdf";
    iframe.src = previewUrl;
    iframe.title = filename;
    content.appendChild(iframe);
  } else if (PREVIEW_TYPES.text.has(ext)) {
    const loading = document.createElement("div");
    loading.className = "preview-loading";
    loading.textContent = "Loading file preview...";
    content.appendChild(loading);

    try {
      const res = await fetch(previewUrl);
      if (!res.ok) throw new Error("Could not load file preview");
      const text = await res.text();
      loading.remove();
      const pre = document.createElement("pre");
      pre.className = "preview-text";
      pre.textContent = text.slice(0, 150000);
      if (text.length > 150000) {
        const trunc = document.createElement("div");
        trunc.className = "preview-truncated";
        trunc.textContent = "Preview truncated at 150 KB. Download full file to view completely.";
        content.append(pre, trunc);
      } else {
        content.appendChild(pre);
      }
    } catch (err) {
      loading.textContent = `Preview unavailable: ${err.message}`;
    }
  }

  modal.classList.remove("hidden");
}

export function closeFilePreview() {
  const modal = document.getElementById("previewModal");
  if (!modal) return;
  const content = document.getElementById("previewContent");
  if (content) {
    const media = content.querySelectorAll("video, audio");
    media.forEach((m) => {
      m.pause();
      m.src = "";
    });
    content.replaceChildren();
  }
  modal.classList.add("hidden");
}

export function initPreviewListeners() {
  document.getElementById("closePreviewBtn")?.addEventListener("click", closeFilePreview);
  const modal = document.getElementById("previewModal");
  modal?.addEventListener("click", (event) => {
    if (event.target.id === "previewModal") closeFilePreview();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal?.classList.contains("hidden")) {
      closeFilePreview();
    }
  });
}
