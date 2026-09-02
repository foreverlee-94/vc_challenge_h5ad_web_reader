// UI controller (main thread). Phase 0: pick a file, show the raw HDF5 tree.
// Dropdown-driven inspection views arrive in Phase 3.

const worker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });

let seq = 0;
const pending = new Map();

worker.onmessage = (ev) => {
  const { id, ok, result, error } = ev.data || {};
  if (id == null) return; // boot ping
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  ok ? p.resolve(result) : p.reject(new Error(error));
};

function call(type, payload, transfer = []) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload }, transfer);
  });
}

// ---- DOM ---------------------------------------------------------------

const el = (id) => document.getElementById(id);
const drop = el("drop");
const fileInput = el("file");
const statusBox = el("status");
const summaryBox = el("summary");
const treeBox = el("tree");

function setStatus(msg, kind = "info") {
  statusBox.textContent = msg;
  statusBox.dataset.kind = kind;
}

function fmtBytes(n) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

async function handleFile(file) {
  if (!file) return;
  if (!/\.h5ad$|\.h5$|\.hdf5$/i.test(file.name)) {
    setStatus(`".h5ad" 파일을 선택해 주세요 (받은 파일: ${file.name})`, "warn");
    return;
  }
  summaryBox.hidden = true;
  treeBox.innerHTML = "";
  setStatus(`${file.name} (${fmtBytes(file.size)}) 여는 중…`, "info");
  const t0 = performance.now();
  try {
    const info = await call("open", { file });
    const ms = Math.round(performance.now() - t0);
    renderSummary(info, ms);
    renderTree(info.tree);
    setStatus(`열림: ${file.name} · ${ms} ms`, "ok");
  } catch (err) {
    setStatus(`열기 실패: ${err.message}`, "error");
  }
}

function renderSummary(info, ms) {
  const rows = [
    ["파일", `${info.file.name} (${fmtBytes(info.file.size)})`],
    ["형식(encoding-type)", info.encoding ?? "(표시 없음 — 순수 HDF5로 해석)"],
    ["encoding-version", info.encodingVersion ?? "—"],
    ["최상위 항목", (info.tree.children || []).map((c) => c.name).join(", ") || "—"],
    ["열기 시간", `${ms} ms`],
  ];
  summaryBox.innerHTML =
    "<h2>개요</h2><table>" +
    rows.map(([k, v]) => `<tr><th>${k}</th><td>${escapeHtml(String(v))}</td></tr>`).join("") +
    "</table>";
  summaryBox.hidden = false;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function shapeStr(shape) {
  if (Array.isArray(shape)) return `[${shape.join(" × ")}]`;
  if (shape && shape.length != null) return `[${shape.length} items]`;
  return "";
}

function nodeLine(node) {
  if (node.kind === "dataset") {
    const meta = [];
    if (node.shape != null) meta.push(shapeStr(node.shape));
    if (node.dtype) meta.push(String(node.dtype));
    return `<span class="k">${escapeHtml(node.name)}</span> <span class="t">dataset</span> <span class="m">${escapeHtml(meta.join("  "))}</span>`;
  }
  if (node.kind === "error") {
    return `<span class="k">${escapeHtml(node.name)}</span> <span class="t err">error: ${escapeHtml(node.error || "")}</span>`;
  }
  const count = node.childCount ?? (node.children ? node.children.length : 0);
  return `<span class="k">${escapeHtml(node.name)}</span> <span class="t">group</span> <span class="m">${count}개 항목${node.truncated ? " · " + escapeHtml(node.truncated) : ""}</span>`;
}

function attrsBlock(attrs) {
  const keys = Object.keys(attrs || {});
  if (!keys.length) return "";
  const items = keys
    .map((k) => {
      let v = attrs[k];
      if (v && typeof v === "object" && "preview" in v) v = `[${v.preview.join(", ")} … (${v.length})]`;
      else if (Array.isArray(v)) v = `[${v.join(", ")}]`;
      return `<li><span class="ak">${escapeHtml(k)}</span> = ${escapeHtml(String(v))}</li>`;
    })
    .join("");
  return `<ul class="attrs">${items}</ul>`;
}

function renderNode(node) {
  if (node.kind === "group") {
    const details = document.createElement("details");
    if (node.name === (currentRootName || "")) details.open = true;
    const summary = document.createElement("summary");
    summary.innerHTML = nodeLine(node);
    details.appendChild(summary);
    const body = document.createElement("div");
    body.className = "body";
    body.insertAdjacentHTML("beforeend", attrsBlock(node.attrs));
    for (const child of node.children || []) body.appendChild(renderNode(child));
    if (node.truncated) {
      const more = document.createElement("div");
      more.className = "more";
      more.textContent = `… ${node.truncated}`;
      body.appendChild(more);
    }
    details.appendChild(body);
    return details;
  }
  const div = document.createElement("div");
  div.className = "leaf";
  div.innerHTML = nodeLine(node) + attrsBlock(node.attrs);
  return div;
}

let currentRootName = "";
function renderTree(tree) {
  currentRootName = tree.name;
  treeBox.innerHTML = "<h2>구조 (원본 HDF5 트리)</h2>";
  treeBox.appendChild(renderNode(tree));
}

// ---- events ----------------------------------------------------------

fileInput.addEventListener("change", () => handleFile(fileInput.files[0]));

["dragenter", "dragover"].forEach((t) =>
  drop.addEventListener(t, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  })
);
["dragleave", "drop"].forEach((t) =>
  drop.addEventListener(t, (e) => {
    e.preventDefault();
    drop.classList.remove("over");
  })
);
drop.addEventListener("drop", (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) handleFile(f);
});

setStatus("h5ad 파일을 선택하거나 여기에 끌어다 놓으세요. 파일은 브라우저 안에서만 열립니다 — 어디에도 업로드되지 않습니다.", "info");
