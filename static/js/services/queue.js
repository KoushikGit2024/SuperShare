// static/js/services/queue.js
// Shared lifecycle controller for upload and download queues:
// clear finished, retry failed, dismiss, and auto-collapse of completed rows.

const COLLAPSE_AFTER_MS = 6000;
const MAX_ROWS = 40;
const FINISHED = new Set(["complete", "failed", "cancelled", "skipped"]);

export function createQueueController(list) {
  const bar = document.createElement("div");
  bar.className = "queue-controls hidden";
  const summary = document.createElement("span");
  summary.className = "queue-summary";
  summary.setAttribute("role", "status");

  const button = (text, handler) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "btn-xs outline";
    el.textContent = text;
    el.onclick = handler;
    return el;
  };
  const rows = () => Array.from(list.children);
  const stateOf = (row) => row.dataset.state || "active";

  const retryBtn = button("Retry all failed", () => {
    rows()
      .filter((r) => stateOf(r) === "failed" && r._retry)
      .forEach((r) => {
        const fn = r._retry;
        r.remove();
        fn();
      });
  });
  const clearBtn = button("Clear finished", () => {
    rows()
      .filter((r) => ["complete", "cancelled", "skipped"].includes(stateOf(r)))
      .forEach((r) => r.remove());
  });
  const dismissBtn = button("Dismiss", () => {
    rows()
      .filter((r) => FINISHED.has(stateOf(r)))
      .forEach((r) => r.remove());
  });
  bar.append(summary, retryBtn, clearBtn, dismissBtn);
  list.before(bar);

  function refresh() {
    const all = rows();
    const finished = all.filter((r) => FINISHED.has(stateOf(r)));
    if (all.length > MAX_ROWS) {
      finished
        .sort((a, b) => Number(a.dataset.finishedAt || 0) - Number(b.dataset.finishedAt || 0))
        .slice(0, all.length - MAX_ROWS)
        .forEach((r) => r.remove());
      return; // removal triggers the observer, which calls refresh again
    }
    const count = (s) => all.filter((r) => stateOf(r) === s).length;
    const active = all.length - finished.length;
    const done = count("complete");
    const failed = count("failed");
    const other = finished.length - done - failed;
    const parts = [];
    if (active) parts.push(`${active} active`);
    if (done) parts.push(`${done} done`);
    if (failed) parts.push(`${failed} failed`);
    if (other) parts.push(`${other} skipped/cancelled`);
    summary.textContent = parts.join(" · ");
    bar.classList.toggle("hidden", !all.length);
    list.classList.toggle("hidden", !all.length);
    retryBtn.classList.toggle("hidden", !failed);
    clearBtn.disabled = !(done || other);
    dismissBtn.disabled = !finished.length;
  }
  new MutationObserver(refresh).observe(list, { childList: true });

  function ensureActions(row) {
    let actions = row.querySelector(".queue-row-actions");
    if (actions) return actions;
    actions = document.createElement("span");
    actions.className = "queue-row-actions";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "queue-row-dismiss";
    dismiss.setAttribute("aria-label", "Dismiss this row");
    dismiss.textContent = "×";
    dismiss.onclick = () => row.remove();
    actions.appendChild(dismiss);
    const progress = row.querySelector("progress");
    if (progress) row.insertBefore(actions, progress);
    else row.appendChild(actions);
    return actions;
  }

  function setState(row, state) {
    row.dataset.state = state;
    row.classList.remove("collapsed");
    clearTimeout(row._collapseTimer);
    if (FINISHED.has(state)) {
      row.dataset.finishedAt = String(Date.now());
      ensureActions(row);
      if (state === "complete")
        row._collapseTimer = setTimeout(() => row.classList.add("collapsed"), COLLAPSE_AFTER_MS);
    }
    refresh();
  }

  function setRetry(row, fn) {
    row._retry = fn;
    const actions = ensureActions(row);
    if (actions.querySelector(".queue-row-retry")) return;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn-xs outline queue-row-retry";
    retry.textContent = "Retry";
    retry.onclick = () => {
      row.remove();
      fn();
    };
    actions.prepend(retry);
    refresh();
  }

  return { setState, setRetry, refresh };
}
