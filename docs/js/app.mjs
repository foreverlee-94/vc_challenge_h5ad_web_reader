// UI controller (main thread).
// Phase 1: pick a file, show a plain-language semantic overview + the raw
// HDF5 tree (collapsed, "advanced"). Dropdown-driven per-item views: Phase 3.
//
// Reading engine: a module Web Worker (h5wasm + WORKERFS, lazy IO). If the
// worker can't boot (older browsers, blocked module workers), we transparently
// fall back to a main-thread engine that loads the file into memory.

let enginePromise = null;

function makeWorkerEngine() {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
    } catch (_) {
      return resolve(null);
    }
    const pending = new Map();
    let seq = 0;
    let booted = false;
    const bootTimer = setTimeout(() => {
      if (!booted) {
        try {
          worker.terminate();
        } catch (_) {}
        resolve(null);
      }
    }, 8000);

    worker.onerror = () => {
      if (!booted) {
        clearTimeout(bootTimer);
        try {
          worker.terminate();
        } catch (_) {}
        resolve(null);
      } else {
        for (const p of pending.values()) p.rej(new Error("백그라운드 작업자 오류"));
        pending.clear();
      }
    };
    worker.onmessageerror = () => {};
    worker.onmessage = (ev) => {
      const d = ev.data || {};
      if (d.boot) {
        booted = true;
        clearTimeout(bootTimer);
        resolve({
          mode: "worker",
          open(file, onProgress) {
            const id = ++seq;
            return new Promise((res, rej) => {
              pending.set(id, { res, rej, onProgress });
              worker.postMessage({ id, type: "open", payload: { file } });
            });
          },
        });
        return;
      }
      const p = pending.get(d.id);
      if (!p) return;
      if (d.progress !== undefined) {
        p.onProgress && p.onProgress(d.progress);
        return;
      }
      pending.delete(d.id);
      d.ok ? p.res(d.result) : p.rej(new Error((d.error || "작업자 오류").split("\n")[0]));
    };
  });
}

async function getEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const forceMain = new URLSearchParams(location.search).get("engine") === "main";
      const w = forceMain ? null : await makeWorkerEngine();
      if (w) return w;
      const { openFileMain } = await import("./mainengine.mjs");
      return { mode: "main", open: (file, onProgress) => openFileMain(file, onProgress) };
    })();
  }
  return enginePromise;
}

// ---- DOM + formatting -------------------------------------------------

const el = (id) => document.getElementById(id);
const drop = el("drop");
const fileInput = el("file");
const statusBox = el("status");
const reportBox = el("report");

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

const num = (n) => (n == null ? "—" : n.toLocaleString("en-US"));
const pct = (x) => (x == null ? "—" : `${(x * 100).toFixed(x < 0.01 ? 3 : 1)}%`);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const KIND_KO = {
  categorical: "범주형",
  numeric: "수치형",
  bool: "참/거짓",
  string: "문자열",
  group: "중첩 그룹",
  missing: "(읽을 수 없음)",
  other: "기타",
};
const kindKo = (k) => KIND_KO[k] || k;

const FORMAT_KO = { csr: "CSR 희소행렬", csc: "CSC 희소행렬", dense: "조밀행렬(dense)", group: "그룹" };

// ---- top-level flow -------------------------------------------------

async function handleFile(file) {
  if (!file) return;
  if (!/\.h5ad$|\.h5$|\.hdf5$/i.test(file.name)) {
    setStatus(`".h5ad" 파일을 선택해 주세요 (받은 파일: ${file.name})`, "warn");
    return;
  }
  reportBox.hidden = true;
  reportBox.innerHTML = "";
  setStatus(`${file.name} (${fmtBytes(file.size)}) 준비 중…`, "info");
  const t0 = performance.now();
  try {
    const eng = await getEngine();
    const info = await eng.open(file, (msg) => setStatus(`${file.name} — ${msg}`, "info"));
    const ms = Math.round(performance.now() - t0);
    render(info, ms);
    setStatus(`열림: ${file.name} · ${ms} ms${eng.mode === "main" ? " · 메인 스레드 모드(파일 전체 메모리 로드)" : ""}`, "ok");
  } catch (err) {
    setStatus(`열기 실패: ${err && err.message ? err.message : err}`, "error");
  }
}

function render(info, ms) {
  const { file, summary, tree } = info;
  reportBox.innerHTML = "";
  reportBox.append(
    overviewCard(file, summary, ms),
    dataframeSection("세포 정보 (obs)", summary.obs, "세포", "유전자 이름 외 추가 컬럼이 없습니다."),
    dataframeSection("유전자 정보 (var)", summary.var, "유전자", "추가 컬럼이 없습니다 (유전자 이름만)."),
    mappingSection(summary),
    unsSection(summary.uns),
  );
  if (summary.raw) reportBox.append(rawSection(summary.raw));
  reportBox.append(advancedTree(tree));
  reportBox.hidden = false;
}

// ---- overview ------------------------------------------------------

function overviewCard(file, s, ms) {
  const sec = document.createElement("section");
  sec.className = "card";
  const X = s.X;
  const enc = s.encoding ? `${s.encoding}${s.encodingVersion ? " " + s.encodingVersion : ""}` : "표시 없음";

  let xLine = "발현값 행렬 X가 없습니다.";
  if (X) {
    const fmt = FORMAT_KO[X.format] || X.format;
    if (X.format === "dense") {
      xLine = `발현값 행렬 X는 <b>${fmt}</b> (${esc(X.dtype || "?")}), 크기 ${num(X.shape[0])} × ${num(X.shape[1])}.`;
    } else {
      xLine = `발현값 행렬 X는 <b>${fmt}</b> (${esc(X.dtype || "?")})이고, 전체의 <b>${pct(X.density)}</b>가 0이 아닌 값입니다 (${num(X.nnz)}개).`;
    }
  }

  sec.innerHTML = `
    <h2>개요</h2>
    <p class="big">${num(s.n_obs)} 세포 &times; ${num(s.n_vars)} 유전자</p>
    <p class="prose">${xLine}</p>
    <table class="kv">
      <tr><th>파일</th><td>${esc(file.name)} (${fmtBytes(file.size)})</td></tr>
      <tr><th>형식</th><td>${esc(enc)}</td></tr>
      <tr><th>발현값 행렬 X</th><td>${X ? `${esc(FORMAT_KO[X.format] || X.format)} · ${esc(X.dtype || "?")}${X.density != null ? " · 밀도 " + pct(X.density) + " · nnz " + num(X.nnz) : ""}` : "없음"}</td></tr>
      <tr><th>obs 컬럼</th><td>${s.obs ? num(s.obs.nColumns) + "개" : "없음"}</td></tr>
      <tr><th>var 컬럼</th><td>${s.var ? num(s.var.nColumns) + "개" : "없음"}</td></tr>
      <tr><th>layers / obsm / varm / obsp / varp</th><td>${mappingCounts(s)}</td></tr>
      <tr><th>uns (비정형)</th><td>${unsCount(s.uns)}</td></tr>
      <tr><th>raw</th><td>${s.raw ? "있음" : "없음"}</td></tr>
      <tr><th>열기 시간</th><td>${ms} ms</td></tr>
    </table>`;
  return sec;
}

function mappingCounts(s) {
  const parts = ["layers", "obsm", "varm", "obsp", "varp"].map((m) => {
    const n = Object.keys(s[m] || {}).length;
    return `${m} ${n}`;
  });
  return parts.join(" · ");
}

function unsCount(uns) {
  const keys = Object.keys(uns || {}).filter((k) => k !== "__truncated__");
  return keys.length ? `${keys.length}개 항목` : "없음";
}

// ---- dataframe (obs / var) --------------------------------------

function dataframeSection(title, df, rowWord, emptyNote) {
  const sec = document.createElement("section");
  sec.className = "card";
  if (!df) {
    sec.innerHTML = `<h2>${esc(title)}</h2><p class="prose">이 파일에는 ${esc(title)}가 없습니다.</p>`;
    return sec;
  }
  const idx = df.index || {};
  const rows = df.columns
    .map(
      (c) => `<tr>
        <td class="mono">${esc(c.name)}</td>
        <td>${esc(kindKo(c.kind))}</td>
        <td class="mono">${esc(c.dtype || "—")}</td>
        <td class="muted">${columnNote(c)}</td>
      </tr>`,
    )
    .join("");

  sec.innerHTML = `
    <h2>${esc(title)}</h2>
    <p class="prose">${num(df.nRows)}개의 ${esc(rowWord)}. 인덱스: <span class="mono">${esc(df.indexName)}</span>
      (${esc(kindKo(idx.kind || "string"))}${idx.nullable ? ", 결측 허용" : ""}).</p>
    ${
      df.columns.length
        ? `<table class="grid"><thead><tr><th>컬럼</th><th>종류</th><th>자료형</th><th>비고</th></tr></thead><tbody>${rows}</tbody></table>`
        : `<p class="muted">${esc(emptyNote)}</p>`
    }`;
  return sec;
}

function columnNote(c) {
  const bits = [];
  if (c.kind === "categorical") bits.push(`범주 ${num(c.nCategories)}개${c.ordered ? " (순서형)" : ""}`);
  if (c.nullable) bits.push("결측 허용");
  if (c.kind === "group" && c.keys) bits.push(`키: ${c.keys.map(esc).join(", ")}`);
  if (c.encoding && c.encoding !== "categorical" && !c.encoding.startsWith("nullable")) bits.push(esc(c.encoding));
  return bits.join(" · ") || "—";
}

// ---- mappings ---------------------------------------------------

function mappingSection(s) {
  const sec = document.createElement("section");
  sec.className = "card";
  const blocks = ["layers", "obsm", "varm", "obsp", "varp"]
    .map((name) => {
      const map = s[name] || {};
      const keys = Object.keys(map);
      if (!keys.length) return `<div class="mapblock"><h3>${name}</h3><p class="muted">없음</p></div>`;
      const items = keys
        .map((k) => {
          const v = map[k];
          let d;
          if (v.format === "dense") d = `조밀 ${shapeStr(v.shape)} · ${esc(v.dtype || "?")}`;
          else if (v.format === "group") d = `그룹 {${(v.keys || []).map(esc).join(", ")}}`;
          else d = `${esc(FORMAT_KO[v.format] || v.format)} ${shapeStr(v.shape)} · ${esc(v.dtype || "?")}${v.density != null ? " · 밀도 " + pct(v.density) : ""}`;
          return `<li><span class="mono">${esc(k)}</span> — ${d}</li>`;
        })
        .join("");
      return `<div class="mapblock"><h3>${name}</h3><ul class="items">${items}</ul></div>`;
    })
    .join("");
  sec.innerHTML = `<h2>레이어 · 임베딩</h2><div class="mapgrid">${blocks}</div>`;
  return sec;
}

function shapeStr(shape) {
  return Array.isArray(shape) ? `[${shape.map(num).join(" × ")}]` : "";
}

// ---- uns ------------------------------------------------------

function unsSection(uns) {
  const sec = document.createElement("section");
  sec.className = "card";
  const keys = Object.keys(uns || {}).filter((k) => k !== "__truncated__");
  if (!keys.length) {
    sec.innerHTML = `<h2>비정형 데이터 (uns)</h2><p class="muted">없음</p>`;
    return sec;
  }
  sec.innerHTML = `<h2>비정형 데이터 (uns)</h2>`;
  sec.appendChild(unsTree(uns));
  return sec;
}

function unsTree(node) {
  const ul = document.createElement("ul");
  ul.className = "unstree";
  for (const key of Object.keys(node)) {
    if (key === "__truncated__") {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = `… ${node[key]}`;
      ul.appendChild(li);
      continue;
    }
    const v = node[key];
    const li = document.createElement("li");
    if (v.kind === "dict") {
      const det = document.createElement("details");
      det.innerHTML = `<summary><span class="mono">${esc(key)}</span> <span class="muted">그룹${v.truncated ? " (더 있음)" : ""}</span></summary>`;
      if (v.children) det.appendChild(unsTree(v.children));
      else if (v.keys) det.insertAdjacentHTML("beforeend", `<div class="muted">키: ${v.keys.map(esc).join(", ")}</div>`);
      li.appendChild(det);
    } else if (v.kind === "scalar") {
      li.innerHTML = `<span class="mono">${esc(key)}</span> = <b>${esc(v.value ?? "?")}</b> <span class="muted">(${esc(v.dtype)})</span>`;
    } else {
      li.innerHTML = `<span class="mono">${esc(key)}</span> <span class="muted">배열 ${shapeStr(v.shape)} · ${esc(v.dtype)}</span>`;
    }
    ul.appendChild(li);
  }
  return ul;
}

// ---- raw ----------------------------------------------------

function rawSection(raw) {
  const sec = document.createElement("section");
  sec.className = "card";
  const X = raw.X;
  sec.innerHTML = `<h2>raw</h2>
    <p class="prose">정규화 이전 원본 카운트가 <span class="mono">raw</span>에 보관되어 있습니다.</p>
    <table class="kv">
      <tr><th>raw.X</th><td>${X ? `${esc(FORMAT_KO[X.format] || X.format)} ${shapeStr(X.shape)} · ${esc(X.dtype || "?")}${X.density != null ? " · 밀도 " + pct(X.density) : ""}` : "없음"}</td></tr>
      <tr><th>raw.var</th><td>${raw.var ? `${num(raw.var.nRows)} 유전자 · ${num(raw.var.nColumns)} 컬럼` : "없음"}</td></tr>
    </table>`;
  return sec;
}

// ---- advanced: raw HDF5 tree ---------------------------------

function advancedTree(tree) {
  const sec = document.createElement("section");
  sec.className = "card";
  const det = document.createElement("details");
  det.innerHTML = `<summary><b>고급:</b> 원본 HDF5 트리</summary>`;
  det.appendChild(renderNode(tree));
  sec.appendChild(det);
  return sec;
}

function nodeLine(node) {
  if (node.kind === "dataset") {
    const meta = [];
    if (node.shape != null) meta.push(Array.isArray(node.shape) ? `[${node.shape.join(" × ")}]` : `[${node.shape.length ?? "?"}]`);
    if (node.dtype) meta.push(String(node.dtype));
    return `<span class="k">${esc(node.name)}</span> <span class="t">dataset</span> <span class="m">${esc(meta.join("  "))}</span>`;
  }
  if (node.kind === "error") return `<span class="k">${esc(node.name)}</span> <span class="t err">error: ${esc(node.error || "")}</span>`;
  const count = node.childCount ?? (node.children ? node.children.length : 0);
  return `<span class="k">${esc(node.name)}</span> <span class="t">group</span> <span class="m">${count}개${node.truncated ? " · " + esc(node.truncated) : ""}</span>`;
}

function attrsBlock(attrs) {
  const keys = Object.keys(attrs || {});
  if (!keys.length) return "";
  const items = keys
    .map((k) => {
      let v = attrs[k];
      if (v && typeof v === "object" && "preview" in v) v = `[${v.preview.join(", ")} … (${v.length})]`;
      else if (Array.isArray(v)) v = `[${v.join(", ")}]`;
      return `<li><span class="ak">${esc(k)}</span> = ${esc(v)}</li>`;
    })
    .join("");
  return `<ul class="attrs">${items}</ul>`;
}

function renderNode(node) {
  if (node.kind === "group") {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.innerHTML = nodeLine(node);
    details.appendChild(summary);
    const body = document.createElement("div");
    body.className = "body";
    body.insertAdjacentHTML("beforeend", attrsBlock(node.attrs));
    for (const c of node.children || []) body.appendChild(renderNode(c));
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

// ---- events -------------------------------------------------

fileInput.addEventListener("change", () => handleFile(fileInput.files[0]));

["dragenter", "dragover"].forEach((t) =>
  drop.addEventListener(t, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  }),
);
["dragleave", "drop"].forEach((t) =>
  drop.addEventListener(t, (e) => {
    e.preventDefault();
    drop.classList.remove("over");
  }),
);
drop.addEventListener("drop", (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) handleFile(f);
});

setStatus("h5ad 파일을 선택하거나 여기에 끌어다 놓으세요. 파일은 브라우저 안에서만 열립니다 — 어디에도 업로드되지 않습니다.", "info");
