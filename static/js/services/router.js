// static/js/services/router.js
// Client-side URL route management, history push/replaceState, and page transitions

const ROUTE_SECTIONS = {
  "/send": "sendSection",
  "/files": "storageSection",
  "/connect": "networkSection",
  "/devices": "devicesSection",
  "/activity": "transfersSection",
  "/storage": "storageMgrSection",
};

const SECTION_ROUTES = Object.fromEntries(
  Object.entries(ROUTE_SECTIONS).map(([route, secId]) => [secId, route])
);

export let activeTabId = "sendSection";
const listeners = new Set();

export function onRouteChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyRoute(sectionId, path) {
  for (const fn of listeners) {
    try {
      fn(sectionId, path);
    } catch (e) {
      console.error("Router listener error:", e);
    }
  }
}

export function routeFromLocation() {
  const path = location.pathname.toLowerCase().replace(/\/+$/, "") || "/";
  if (ROUTE_SECTIONS[path]) return ROUTE_SECTIONS[path];

  const hash = (location.hash || "").replace(/^#/, "");
  if (hash && document.getElementById(hash)) return hash;

  // Default route
  return "sendSection";
}

export function navigateTo(sectionId, pushHistory = true) {
  const tabs = document.querySelectorAll(".tab-btn[data-tab]");
  const panels = document.querySelectorAll(".tab-panel");
  if (!panels.length) return;

  const targetPanel = document.getElementById(sectionId);
  if (!targetPanel) return;

  activeTabId = sectionId;

  tabs.forEach((tab) => {
    const isTarget = tab.dataset.tab === sectionId;
    tab.classList.toggle("active", isTarget);
    tab.setAttribute("aria-selected", isTarget ? "true" : "false");
    tab.setAttribute("tabindex", isTarget ? "0" : "-1");
  });

  panels.forEach((panel) => {
    const isTarget = panel.id === sectionId;
    panel.classList.toggle("tab-hidden", !isTarget);
  });

  const canonicalPath = SECTION_ROUTES[sectionId] || "/send";
  if (pushHistory) {
    history.pushState({ sectionId }, "", canonicalPath);
  } else {
    history.replaceState({ sectionId }, "", canonicalPath);
  }

  notifyRoute(sectionId, canonicalPath);
}

export function initRouter() {
  const tabs = Array.from(document.querySelectorAll(".tab-btn[data-tab]"));

  tabs.forEach((tab, idx) => {
    tab.addEventListener("click", () => {
      navigateTo(tab.dataset.tab, true);
    });

    tab.addEventListener("keydown", (event) => {
      let nextIndex = null;
      if (event.key === "ArrowRight") nextIndex = (idx + 1) % tabs.length;
      else if (event.key === "ArrowLeft") nextIndex = (idx - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = tabs.length - 1;

      if (nextIndex !== null) {
        event.preventDefault();
        tabs[nextIndex].focus();
        navigateTo(tabs[nextIndex].dataset.tab, true);
      }
    });
  });

  window.addEventListener("popstate", (event) => {
    const sec = event.state?.sectionId || routeFromLocation();
    navigateTo(sec, false);
  });

  // Drag & drop automatically switches to send
  window.addEventListener("dragenter", (event) => {
    if (event.dataTransfer?.types?.includes("Files") && activeTabId !== "sendSection") {
      navigateTo("sendSection", true);
    }
  });

  // Initial boot route
  const initialSection = routeFromLocation();
  navigateTo(initialSection, false);
}
