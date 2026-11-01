// static/js/services/hud.js
// Floating transfer HUD: compact badge (count, speed, ETA) that expands into a live drawer.
import { formatBytes, formatDuration } from "./utils.js";

const jobs = new Map();
let seq = 0,
  root,
  badge,
  drawer,
  list,
  timer = 0;

function setExpanded(open) {
  drawer.classList.toggle("hidden", !open);
  badge.setAttribute("aria-expanded", String(open));
  if (open) render();
}

function ensureDom() {
  if (root) return;
  root = document.createElement("div");
  root.id = "transferHud";
  root.className = "transfer-hud hidden";
  badge = document.createElement("button");
  badge.type = "button";
  badge.className = "hud-badge";
  badge.setAttribute("aria-expanded", "false");
  badge.setAttribute("aria-controls", "hudDrawer");
  drawer = document.createElement("div");
  drawer.id = "hudDrawer";
  drawer.className = "hud-drawer hidden";
  drawer.setAttribute("role", "region");
  drawer.setAttribute("aria-label", "Live transfers");
  list = document.createElement("ul");
  list.className = "hud-list";
  drawer.appendChild(list);
  root.append(drawer, badge);
  document.body.appendChild(root);
  badge.addEventListener("click", () => setExpanded(drawer.classList.contains("hidden")));
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      !drawer.classList.contains("hidden") &&
      !document.querySelector("dialog[open]")
    ) {
      setExpanded(false);
      badge.focus();
    }
  });
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = 0;
    render();
  }, 200);
}

function rowFor(job) {
  const li = document.createElement("li");
  li.className = `hud-row ${job.status}`;
  const title = document.createElement("strong");
  title.textContent = job.label;
  const pct = job.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
  const state = document.createElement("span");
  state.textContent =
    job.status === "active"
      ? `${job.kind === "upload" ? "Uploading" : "Downloading"} · ${pct}%${job.rate ? ` · ${formatBytes(job.rate)}/s` : ""}`
      : job.status === "complete"
        ? "Finished"
        : job.status === "failed"
          ? "Failed"
          : "Cancelled";
  const progress = document.createElement("progress");
  progress.max = job.total || 1;
  progress.value = Math.min(job.done, job.total || 1);
  progress.setAttribute("aria-label", `${job.label}: ${pct}%`);
  li.append(title, state, progress);
  return li;
}

function render() {
  const all = [...jobs.values()];
  root.classList.toggle("hidden", !all.length);
  const active = all.filter((job) => job.status === "active");
  const rate = active.reduce((sum, job) => sum + job.rate, 0);
  const remaining = active.reduce((sum, job) => sum + Math.max(0, job.total - job.done), 0);
  badge.textContent = active.length
    ? `${active.length} active · ${formatBytes(rate)}/s${rate > 0 && remaining ? ` · ETA ${formatDuration(remaining / rate)}` : ""}`
    : "Transfers finished";
  if (!drawer.classList.contains("hidden")) list.replaceChildren(...all.map(rowFor));
}

export function trackTransfer({ kind, label }) {
  ensureDom();
  const id = ++seq;
  const job = { id, kind, label, done: 0, total: 0, rate: 0, status: "active" };
  jobs.set(id, job);
  schedule();
  return {
    update({ done, total, rate }) {
      job.done = done;
      job.total = total;
      job.rate = rate || 0;
      schedule();
    },
    finish(status) {
      job.status = status;
      job.rate = 0;
      if (status === "complete") job.done = job.total;
      schedule();
      setTimeout(
        () => {
          jobs.delete(id);
          schedule();
        },
        status === "failed" ? 30000 : 4000
      );
    },
  };
}
