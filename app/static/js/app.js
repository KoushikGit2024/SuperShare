let currentPath = "";
let currentItems = [];
let selectedItems = new Map();
let currentHostBrowsePath = "";

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024, sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function updateSelectionUI() {
  const count = selectedItems.size;
  let totalBytes = 0;
  selectedItems.forEach((meta) => {
    if (!meta.is_dir) totalBytes += meta.size || 0;
  });

  document.getElementById("selectionSummary").textContent = `${count} selected`;
  const bar = document.getElementById("selectionActionBar");
  if (count > 0) {
    bar.classList.remove("hidden");
    document.getElementById("barSelectedCount").textContent = `${count} item(s) selected`;
    document.getElementById("barSelectedSize").textContent = `Size: ${formatBytes(totalBytes)}`;
  } else {
    bar.classList.add("hidden");
  }

  const selectAllBox = document.getElementById("selectAllCheckbox");
  if (currentItems.length === 0) {
    selectAllBox.checked = false;
  } else {
    const selCount = currentItems.filter(item => selectedItems.has(currentPath ? `${currentPath}/${item.name}` : item.name)).length;
    selectAllBox.checked = selCount === currentItems.length;
  }
}

async function fetchDirectory(path = "") {
  currentPath = path;
  selectedItems.clear();
  document.getElementById("breadcrumbBar").textContent = "📍 Subpath: /" + path;
  document.getElementById("zipCurrentBtn").href = "/api/zip?path=" + encodeURIComponent(path);

  const res = await fetch("/api/list?path=" + encodeURIComponent(path));
  const data = await res.json();
  currentItems = data.items || [];
  if (data.share_root) {
    currentHostBrowsePath = data.share_root;
    document.getElementById("hostRootText").textContent = `Host: ${data.share_root}`;
  }

  const listEl = document.getElementById("fileList");
  listEl.innerHTML = "";

  if (path !== "") {
    const parent = path.split("/").slice(0, -1).join("/");
    const li = document.createElement("li");
    li.className = "file-item";
    li.innerHTML = `<div class="file-info"><a href="#" class="file-link">⬅️ .. (Back to Parent)</a></div>`;
    li.querySelector("a").onclick = (e) => { e.preventDefault(); fetchDirectory(parent); };
    listEl.appendChild(li);
  }

  if (currentItems.length === 0) {
    listEl.innerHTML += `<li class="empty-state">Folder is empty</li>`;
    updateSelectionUI();
    return;
  }

  currentItems.forEach((item) => {
    const relPath = path ? `${path}/${item.name}` : item.name;
    const encoded = encodeURIComponent(relPath);
    const li = document.createElement("li");
    li.className = "file-item";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "item-checkbox";
    cb.onchange = (e) => {
      if (e.target.checked) { selectedItems.set(relPath, item); li.classList.add("selected"); }
      else { selectedItems.delete(relPath); li.classList.remove("selected"); }
      updateSelectionUI();
    };

    const left = document.createElement("div");
    left.className = "item-left";
    left.appendChild(cb);

    const info = document.createElement("div");
    info.className = "file-info";

    if (item.is_dir) {
      info.innerHTML = `<a href="#" class="file-link">📁 ${item.name}</a><div class="file-meta">Folder • Tap to open</div>`;
      info.querySelector("a").onclick = (e) => { e.preventDefault(); fetchDirectory(relPath); };
      const btn = document.createElement("a");
      btn.href = `/api/zip?path=${encoded}`;
      btn.className = "dl-btn folder";
      btn.textContent = "📦 ZIP";
      left.appendChild(info);
      li.appendChild(left);
      li.appendChild(btn);
    } else {
      info.innerHTML = `<a href="/api/download?path=${encoded}" class="file-link" download>📄 ${item.name}</a><div class="file-meta">${formatBytes(item.size)}</div>`;
      const btn = document.createElement("a");
      btn.href = `/api/download?path=${encoded}`;
      btn.className = "dl-btn";
      btn.setAttribute("download", "");
      btn.textContent = "⬇️ Save";
      left.appendChild(info);
      li.appendChild(left);
      li.appendChild(btn);
    }
    listEl.appendChild(li);
  });
  updateSelectionUI();
}

// Host PC Drive & Folder Browser Modal Logic
async function loadHostModalFolders(dirPath) {
  const res = await fetch("/api/host-folders?dir=" + encodeURIComponent(dirPath || ""));
  const data = await res.json();
  currentHostBrowsePath = data.current;
  document.getElementById("modalCurrentPath").textContent = "📍 " + data.current;

  const drivesBar = document.getElementById("drivesBar");
  drivesBar.innerHTML = "";
  (data.drives || []).forEach(d => {
    const b = document.createElement("button");
    b.className = "btn-xs outline";
    b.textContent = "💽 " + d.name;
    b.onclick = () => loadHostModalFolders(d.path);
    drivesBar.appendChild(b);
  });

  const list = document.getElementById("modalFolderList");
  list.innerHTML = "";
  if (data.parent) {
    const upLi = document.createElement("li");
    upLi.textContent = "⬅️ .. (Up One Level)";
    upLi.onclick = () => loadHostModalFolders(data.parent);
    list.appendChild(upLi);
  }
  (data.folders || []).forEach(f => {
    const li = document.createElement("li");
    li.textContent = "📁 " + f.name;
    li.onclick = () => loadHostModalFolders(f.path);
    list.appendChild(li);
  });
}

document.getElementById("openDriveBrowserBtn").onclick = () => {
  document.getElementById("hostModal").classList.remove("hidden");
  loadHostModalFolders(currentHostBrowsePath);
};

document.getElementById("closeModalBtn").onclick = () => {
  document.getElementById("hostModal").classList.add("hidden");
};

document.getElementById("selectThisHostFolderBtn").onclick = async () => {
  const res = await fetch("/api/set-share-dir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ share_dir: currentHostBrowsePath })
  });
  if (res.ok) {
    document.getElementById("hostModal").classList.add("hidden");
    fetchDirectory("");
  }
};

document.getElementById("nativePickerBtn").onclick = async () => {
  const res = await fetch("/api/pick-host-gui");
  if (res.ok) fetchDirectory("");
};

document.getElementById("selectAllCheckbox").onchange = (e) => {
  const check = e.target.checked;
  currentItems.forEach((item) => {
    const rel = currentPath ? `${currentPath}/${item.name}` : item.name;
    if (check) selectedItems.set(rel, item);
    else selectedItems.delete(rel);
  });
  document.querySelectorAll(".file-item").forEach(li => {
    if (check) li.classList.add("selected"); else li.classList.remove("selected");
  });
  document.querySelectorAll(".item-checkbox").forEach(cb => cb.checked = check);
  updateSelectionUI();
};

document.getElementById("downloadSelectedBtn").onclick = () => {
  if (selectedItems.size === 0) return;
  window.location.href = `/api/zip-selected?items=${encodeURIComponent(JSON.stringify(Array.from(selectedItems.keys())))}`;
};

document.getElementById("deleteSelectedBtn").onclick = async () => {
  if (!confirm(`Delete ${selectedItems.size} selected item(s)?`)) return;
  await fetch("/api/delete-selected", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: Array.from(selectedItems.keys()) })
  });
  fetchDirectory(currentPath);
};

document.getElementById("clearSelectionBtn").onclick = () => {
  selectedItems.clear();
  document.querySelectorAll(".item-checkbox").forEach(cb => cb.checked = false);
  document.querySelectorAll(".file-item").forEach(li => li.classList.remove("selected"));
  updateSelectionUI();
};

async function uploadFiles(filesList) {
  if (!filesList.length) return;
  const pBox = document.getElementById("progressContainer");
  const fName = document.getElementById("uploadFileName");
  const bar = document.getElementById("uploadBarFill");
  const pct = document.getElementById("uploadPercent");
  const spd = document.getElementById("uploadSpeed");
  pBox.classList.remove("hidden");

  for (let i = 0; i < filesList.length; i++) {
    const file = filesList[i];
    const rel = file.webkitRelativePath || file.name;
    const dest = currentPath ? `${currentPath}/${rel}` : rel;
    fName.textContent = `Uploading (${i+1}/${filesList.length}): ${rel}`;

    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const start = Date.now();
      xhr.open("POST", "/api/upload", true);
      xhr.setRequestHeader("X-File-Path", encodeURIComponent(dest));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const p = Math.round((e.loaded / e.total) * 100);
          bar.style.width = p + "%";
          pct.textContent = `${p}%`;
          const sec = (Date.now() - start) / 1000;
          if (sec > 0) spd.textContent = formatBytes(e.loaded / sec) + "/s";
        }
      };
      xhr.onload = () => resolve();
      xhr.onerror = () => reject();
      xhr.send(file);
    });
  }
  fName.textContent = "✅ Upload Complete!";
  fetchDirectory(currentPath);
}

document.getElementById("fileInput").onchange = (e) => uploadFiles(e.target.files);
document.getElementById("folderInput").onchange = (e) => uploadFiles(e.target.files);

document.getElementById("newFolderBtn").onclick = async () => {
  const name = prompt("New folder name:");
  if (!name) return;
  const path = currentPath ? `${currentPath}/${name}` : name;
  await fetch("/api/mkdir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
  fetchDirectory(currentPath);
};

fetchDirectory();
