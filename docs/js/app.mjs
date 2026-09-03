// UI controller (main thread).
// - Plain-language overview of the file (Phase 1).
// - "항목 살펴보기": cascading dropdowns (component -> key -> view) that read
//   the actual values and render tables / bar charts / histograms / matrix
//   slices (Phase 2+3).
// - Raw HDF5 tree under "advanced".
//
// Reading engine: a module Web Worker (h5wasm + WORKERFS, lazy IO). If the
// worker can't boot (older browsers, blocked module workers), we transparently
// fall back to a main-thread engine that loads the file into memory. Both
// expose the same eng.call(type, payload, onProgress).

import { barChartSVG, histogramSVG } from "./charts.mjs";
import { histogram } from "./stats.mjs";

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
          call(type, payload, onProgress) {
            const id = ++seq;
            return new Promise((res, rej) => {
              pending.set(id, { res, rej, onProgress });
              worker.postMessage({ id, type, payload });
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
      const { mainEngine } = await import("./mainengine.mjs");
      return mainEngine;
    })();
  }
  return enginePromise;
}

// ---- DOM + formatting -------------------------------------------------

const el = (id) => document.getElementById(id);
const fileInput = el("file");
const folderInput = el("folder");
const openBtn = el("openbtn");
const scanBtn = el("scanbtn");
const intro = el("intro");
const statusBox = el("status");
const topnav = el("topnav");
const filebar = el("filebar");
const warnBox = el("warn");
const tabs = {
  overview: el("tab-overview"),
  explore: el("tab-explore"),
  raw: el("tab-raw"),
  scan: el("tab-scan"),
};
const millerEl = el("miller");
const detailEl = el("detail");
const breadcrumbEl = el("breadcrumb");

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

let openInfo = null; // { file, summary, tree } for the currently open file
let engineMode = "worker";
const state = { tab: "overview", path: [], view: null, previewOffset: 0, freqOffset: 0, slice: null };

function resetViewState() {
  state.view = null;
  state.previewOffset = 0;
  state.freqOffset = 0;
  state.slice = null;
}

let loading = false;

async function handleFile(file) {
  if (!file) return;
  if (!/\.h5ad$|\.h5$|\.hdf5$/i.test(file.name)) {
    setStatus(`.h5ad / .h5 / .hdf5 파일을 선택해 주세요 (받은 파일: ${file.name})`, "warn");
    return;
  }
  if (loading) {
    setStatus(`이전 파일을 여는 중입니다 — 잠시 후 다시 시도하세요.`, "warn");
    return;
  }
  loading = true;
  for (const t of Object.values(tabs)) t.hidden = true;
  tabs.overview.innerHTML = "";
  tabs.raw.innerHTML = "";
  millerEl.innerHTML = "";
  detailEl.innerHTML = "";
  breadcrumbEl.innerHTML = "";
  warnBox.hidden = true;
  setStatus(`${file.name} (${fmtBytes(file.size)}) 준비 중…`, "info");
  const t0 = performance.now();
  try {
    const eng = await getEngine();
    engineMode = eng.mode;
    const info = await eng.call("open", { file }, (msg) => setStatus(`${file.name} — ${msg}`, "info"));
    const ms = Math.round(performance.now() - t0);
    openInfo = info;
    labelCache = {};
    setStatus(`로드 완료 · ${file.name} · ${ms} ms${eng.mode === "main" ? " · 메인 스레드 모드(파일 전체 메모리 로드)" : ""}`, "ok");
    intro.hidden = true;
    openBtn.hidden = true;
    topnav.hidden = false;
    filebar.hidden = false;
    el("filebar-name").textContent = file.name;
    el("filebar-meta").textContent = ` ${fmtBytes(file.size)} · ${eng.mode === "main" ? "메인 스레드" : "백그라운드 작업자"}`;
    showWarning(file, eng.mode);
    buildOverviewTab(info, ms);
    buildRawTab(info.tree);
    state.path = [];
    resetViewState();
    await buildExploreTab();
    setTab(state.tab === "explore" ? "explore" : "overview");
  } catch (err) {
    setStatus(`열기 실패: ${err && err.message ? err.message : err}`, "error");
  } finally {
    loading = false;
  }
}

function showWarning(file, mode) {
  const isSafari = /^((?!chrome|chromium|android|crios|edg).)*safari/i.test(navigator.userAgent);
  let msg = null;
  if (mode === "main" && file.size > 300e6)
    msg = `메인 스레드 모드에서는 이 파일(${fmtBytes(file.size)})이 전부 메모리에 올라갑니다. 브라우저가 느려지거나 멈출 수 있습니다.`;
  else if (isSafari && file.size > 500e6)
    msg = `Safari는 WebAssembly 메모리 한도가 낮아 큰 파일(${fmtBytes(file.size)})에서 실패할 수 있습니다. Chrome 또는 Edge를 권장합니다.`;
  else if (file.size > 1.5e9)
    msg = `매우 큰 파일(${fmtBytes(file.size)})입니다. 데스크톱 Chrome/Edge에서도 메모리 부족으로 실패할 수 있습니다.`;
  warnBox.hidden = !msg;
  if (msg) warnBox.textContent = "⚠ " + msg;
}

function setTab(name) {
  state.tab = name;
  for (const [k, sec] of Object.entries(tabs)) sec.hidden = k !== name;
  for (const b of topnav.querySelectorAll("button")) b.classList.toggle("active", b.dataset.tab === name);
  // tables measured while the pane was hidden couldn't size their columns; retry now
  if (name === "explore") requestAnimationFrame(() => enhanceIn(detailEl));
}

function buildOverviewTab(info, ms) {
  const { file, summary } = info;
  const box = tabs.overview;
  box.innerHTML = "";
  const add = (sec, span) => {
    sec.classList.add(span);
    box.appendChild(sec);
  };
  add(overviewCard(file, summary, ms), "ov12");
  add(dataframeSection("세포 정보 (obs)", summary.obs, "세포"), "ov6");
  add(dataframeSection("유전자 정보 (var)", summary.var, "유전자"), "ov6");
  add(mappingSection(summary), "ov8");
  add(unsSection(summary.uns), "ov4");
  if (summary.raw) add(rawSection(summary.raw), "ov12");
}

function buildRawTab(tree) {
  const box = tabs.raw;
  box.innerHTML = "";
  const card = document.createElement("section");
  card.className = "card";
  card.innerHTML = `<h2>원본 HDF5 트리</h2>`;
  const rootNode = renderNode(tree);
  if (rootNode.tagName === "DETAILS") rootNode.open = true;
  card.appendChild(rootNode);
  box.appendChild(card);
}

// ---- folder scan: gene-count distribution across a folder of .h5ad --------

const H5_RE = /\.(h5ad|h5|hdf5)$/i;
let scanFileMap = new Map(); // path -> File (for row-click open)

// Recursively collect File objects from FileSystemEntry[] (drag-dropped folder).
function filesFromEntries(entries) {
  const out = [];
  const readDir = (reader) =>
    new Promise((res, rej) => {
      const all = [];
      const pump = () =>
        reader.readEntries((batch) => {
          if (!batch.length) return res(all);
          all.push(...batch);
          pump();
        }, rej);
      pump();
    });
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      try {
        Object.defineProperty(file, "relPath", { value: prefix + entry.name });
      } catch (_) {}
      out.push(file);
    } else if (entry.isDirectory) {
      for (const e of await readDir(entry.createReader())) await walk(e, prefix + entry.name + "/");
    }
  };
  return (async () => {
    for (const e of entries) await walk(e, "");
    return out;
  })();
}

const relOf = (f) => f.relPath || f.webkitRelativePath || f.name;
const dirOf = (p) => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "(루트)" : p.slice(0, i) || "(루트)";
};

let scanning = false;

async function scanFolder(files) {
  if (scanning) return;
  const h5 = files.filter((f) => H5_RE.test(f.name)).sort((a, b) => relOf(a).localeCompare(relOf(b)));
  if (!h5.length) {
    setStatus("선택한 폴더에 .h5ad / .h5 / .hdf5 파일이 없습니다.", "warn");
    return;
  }
  scanning = true;
  scanFileMap = new Map(h5.map((f) => [relOf(f), f]));
  intro.hidden = true;
  const t0 = performance.now();
  const rows = [];
  try {
    const eng = await getEngine();
    for (let i = 0; i < h5.length; i++) {
      const f = h5[i];
      setStatus(`폴더 스캔 ${i + 1} / ${h5.length} — ${relOf(f)}`, "info");
      try {
        const q = await eng.call("scanFile", { file: f });
        // gene count = distinct var identifiers (falls back to the dimension)
        const genes = q.nVarUnique ?? q.nVars;
        rows.push({
          path: relOf(f),
          dir: dirOf(relOf(f)),
          size: f.size,
          nVars: genes,
          nVarsRaw: q.nVars,
          dup: q.nVarUnique != null && q.nVars != null ? q.nVars - q.nVarUnique : 0,
          nObs: q.nObs,
          xFormat: q.xFormat,
        });
      } catch (err) {
        rows.push({ path: relOf(f), dir: dirOf(relOf(f)), size: f.size, error: (err && err.message) || String(err) });
      }
    }
    const ms = Math.round(performance.now() - t0);
    setStatus(`폴더 스캔 완료 · ${h5.length}개 파일 · ${ms} ms${eng.mode === "main" ? " · 메인 스레드 모드" : ""}`, "ok");
    topnav.hidden = false;
    topnav.querySelector('button[data-tab="scan"]').hidden = false;
    renderScanTab(rows);
    setTab("scan");
  } catch (err) {
    setStatus(`폴더 스캔 실패: ${err && err.message ? err.message : err}`, "error");
  } finally {
    scanning = false;
  }
}

let scanRowsState = { rows: [], sort: "path", dir: 1, offset: 0 };
const SCAN_PAGE = 60;

function renderScanTab(rows) {
  scanRowsState = { rows, sort: "path", dir: 1, offset: 0 };
  drawScan();
}

function drawScan() {
  const { rows } = scanRowsState;
  const box = tabs.scan;
  const ok = rows.filter((r) => r.nVars != null);
  const genes = ok.map((r) => r.nVars);
  const errs = rows.filter((r) => r.error);

  // per-folder breakdown
  const byDir = new Map();
  for (const r of rows) {
    if (!byDir.has(r.dir)) byDir.set(r.dir, []);
    byDir.get(r.dir).push(r);
  }
  const dirRows = [...byDir.entries()]
    .map(([d, rs]) => {
      const g = rs.map((r) => r.nVars).filter((v) => v != null);
      return { dir: d, n: rs.length, min: g.length ? Math.min(...g) : null, max: g.length ? Math.max(...g) : null, uniq: new Set(g).size };
    })
    .sort((a, b) => a.dir.localeCompare(b.dir));

  const dupFiles = rows.filter((r) => r.dup > 0);
  const stat =
    genes.length === 0
      ? `<p class="muted">유전자 개수를 읽을 수 있는 파일이 없습니다.</p>`
      : `<p class="muted">유전자 수 = var 인덱스의 <b>서로 다른(unique)</b> 식별자 개수.</p>
        <table class="kv">
          <tr><th>파일 수</th><td>${num(rows.length)}${errs.length ? ` (오류 ${num(errs.length)})` : ""}</td></tr>
          <tr><th>유전자 수 최소 / 최대</th><td>${num(Math.min(...genes))} / ${num(Math.max(...genes))}</td></tr>
          <tr><th>중앙값</th><td>${num(median(genes))}</td></tr>
          <tr><th>서로 다른 유전자 수(파일 간)</th><td>${num(new Set(genes).size)}종</td></tr>
          ${dupFiles.length ? `<tr><th>var 인덱스에 중복이 있는 파일</th><td>${num(dupFiles.length)}개</td></tr>` : ""}
        </table>`;

  const hist = genes.length ? histogramSVG(histogram(genes, Math.min(30, Math.max(6, new Set(genes).size)))) : "";

  const dirTable =
    byDir.size > 1
      ? `<h3>폴더별</h3><table class="grid"><thead><tr><th>폴더</th><th class="n">파일</th><th class="n">유전자 최소</th><th class="n">최대</th><th class="n">종류</th></tr></thead><tbody>${dirRows
          .map(
            (d) =>
              `<tr><td class="mono">${esc(d.dir)}</td><td class="n">${num(d.n)}</td><td class="n">${num(d.min)}</td><td class="n">${num(d.max)}</td><td class="n">${num(d.uniq)}</td></tr>`,
          )
          .join("")}</tbody></table>`
      : "";

  // sortable + paged file table
  const sorters = {
    path: (a, b) => a.path.localeCompare(b.path),
    nVars: (a, b) => (a.nVars ?? -1) - (b.nVars ?? -1),
    nObs: (a, b) => (a.nObs ?? -1) - (b.nObs ?? -1),
    size: (a, b) => a.size - b.size,
  };
  const sorted = [...rows].sort((a, b) => sorters[scanRowsState.sort](a, b) * scanRowsState.dir);
  const off = Math.min(scanRowsState.offset, Math.max(0, Math.floor((rows.length - 1) / SCAN_PAGE) * SCAN_PAGE));
  const page = sorted.slice(off, off + SCAN_PAGE);
  const arrow = (k) => (scanRowsState.sort === k ? (scanRowsState.dir === 1 ? " ▲" : " ▼") : "");
  const frows = page
    .map(
      (r) =>
        `<tr data-path="${esc(r.path)}">
          <td class="mono">${esc(r.path)}</td>
          <td class="n">${r.error ? '<span class="err">오류</span>' : num(r.nVars) + (r.dup > 0 ? ` <span class="muted">(행 ${num(r.nVarsRaw)}, 중복 ${num(r.dup)})</span>` : "")}</td>
          <td class="n">${r.error ? "" : num(r.nObs)}</td>
          <td class="n muted">${r.xFormat || ""}</td>
          <td class="n muted">${fmtBytes(r.size)}</td>
        </tr>`,
    )
    .join("");

  box.innerHTML = `
    <section class="card">
      <h2>폴더 스캔 — 유전자 개수 분포</h2>
      ${stat}
      ${hist}
    </section>
    ${dirTable ? `<section class="card">${dirTable}</section>` : ""}
    <section class="card">
      <h3>파일 목록 <span class="muted">(행 클릭 시 열기)</span></h3>
      <div class="tablescroll">
        <table class="grid scan-files"><thead><tr>
          <th data-s="path">경로${arrow("path")}</th>
          <th data-s="nVars" class="n">유전자 수${arrow("nVars")}</th>
          <th data-s="nObs" class="n">세포 수${arrow("nObs")}</th>
          <th class="n">X 형식</th>
          <th data-s="size" class="n">크기${arrow("size")}</th>
        </tr></thead><tbody>${frows}</tbody></table>
      </div>
      ${pagerHTML(off, SCAN_PAGE, rows.length, "개")}
    </section>`;

  for (const th of box.querySelectorAll("th[data-s]")) {
    th.style.cursor = "pointer";
    th.addEventListener("click", () => {
      const k = th.dataset.s;
      scanRowsState.dir = scanRowsState.sort === k ? -scanRowsState.dir : 1;
      scanRowsState.sort = k;
      scanRowsState.offset = 0;
      drawScan();
    });
  }
  wirePager(box, off, SCAN_PAGE, rows.length, (n) => {
    scanRowsState.offset = n;
    drawScan();
  });
  for (const tr of box.querySelectorAll("tbody tr[data-path]")) {
    tr.style.cursor = "pointer";
    tr.addEventListener("click", () => {
      const f = scanFileMap.get(tr.dataset.path);
      if (f) handleFile(f);
    });
  }
}

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

// ---- overview ------------------------------------------------------

function overviewCard(file, s, ms) {
  const sec = document.createElement("section");
  sec.className = "card";
  const X = s.X;
  const enc = s.encoding ? `${s.encoding}${s.encodingVersion ? " " + s.encodingVersion : ""}` : "(표시 없음)";

  let xLine;
  if (!X) xLine = "발현 행렬 X 없음.";
  else if (X.format === "dense")
    xLine = `발현 행렬 X — 조밀 형식 (${esc(X.dtype || "?")}), ${num(X.shape[0])} × ${num(X.shape[1])}.`;
  else
    xLine = `발현 행렬 X — ${esc(FORMAT_KO[X.format] || X.format)} (${esc(X.dtype || "?")}), 비영 원소 ${num(X.nnz)}개, 밀도 ${pct(X.density)}.`;

  const facts = [
    ["파일", `${esc(file.name)} · ${fmtBytes(file.size)}`],
    ["AnnData 형식", esc(enc)],
    ["발현 행렬 X", X ? `${esc(FORMAT_KO[X.format] || X.format)} · ${esc(X.dtype || "?")}` : "없음"],
    ["X 밀도 / 비영 원소", X && X.density != null ? `${pct(X.density)} · ${num(X.nnz)}` : "—"],
    ["obs 컬럼", s.obs ? `${num(s.obs.nColumns)}개` : "없음"],
    ["var 컬럼", s.var ? `${num(s.var.nColumns)}개` : "없음"],
    ["layers·obsm·varm·obsp·varp", mappingCounts(s)],
    ["uns 항목", unsCount(s.uns)],
    ["raw", s.raw ? "있음" : "없음"],
    ["로드", `${ms} ms · ${engineMode === "main" ? "메인 스레드" : "백그라운드 작업자"}`],
  ];

  sec.innerHTML = `
    <h2>개요</h2>
    <p class="big">${num(s.n_obs)} 세포 &times; ${num(s.n_vars)} 유전자</p>
    <p class="prose">${xLine}</p>
    <dl class="facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
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

// ---- explore tab: Miller columns + detail pane ---------------

let labelCache = {}; // axis -> { map: Map(label->idx), n, tooLarge }

function unsHasKeys(uns) {
  return Object.keys(uns || {}).filter((k) => k !== "__truncated__").length > 0;
}

// Children of a nav path, from the summary where possible; uns is lazy.
async function navChildren(path) {
  const s = openInfo.summary;
  if (path.length === 0) {
    const out = [];
    if (s.X) out.push({ seg: "X", label: "X — 발현 행렬", kind: "matrix" });
    if (s.obs) out.push({ seg: "obs", label: "obs — 세포 정보", kind: "dataframe" });
    if (s.var) out.push({ seg: "var", label: "var — 유전자 정보", kind: "dataframe" });
    for (const m of ["layers", "obsm", "varm", "obsp", "varp"])
      if (Object.keys(s[m] || {}).length) out.push({ seg: m, label: m, kind: "mapping" });
    if (unsHasKeys(s.uns)) out.push({ seg: "uns", label: "uns — 비정형", kind: "uns-dict" });
    if (s.raw) out.push({ seg: "raw", label: "raw", kind: "group" });
    return out;
  }
  const head = path[0];

  if (head === "obs" || head === "var") {
    if (path.length !== 1) return [];
    return dfChildren(s[head], head === "obs" ? "세포 이름" : "유전자 이름");
  }
  if (head === "X") return [];
  if (["layers", "obsm", "varm", "obsp", "varp"].includes(head)) {
    if (path.length !== 1) return [];
    return Object.entries(s[head]).map(([k, v]) => ({
      seg: k,
      label: k,
      kind: v.format === "dense" ? (Array.isArray(v.shape) && v.shape.length === 1 ? "vector" : "matrix") : v.format === "group" ? "group" : "matrix",
    }));
  }
  if (head === "raw") {
    if (path.length === 1) {
      const out = [];
      if (s.raw.X) out.push({ seg: "X", label: "X", kind: "matrix" });
      if (s.raw.var) out.push({ seg: "var", label: "var", kind: "dataframe" });
      return out;
    }
    if (path[1] === "var" && path.length === 2) return dfChildren(s.raw.var, "유전자 이름");
    return [];
  }
  if (head === "uns") {
    const p = "uns" + path.slice(1).map((x) => "/" + x).join("");
    const eng = await getEngine();
    const d = await eng.call("unsNode", { path: p });
    if (d.kind !== "dict") return [];
    const keys = d.keys || [];
    if (keys.length > 40) return keys.map((k) => ({ seg: k, label: k, kind: "uns-node" }));
    const out = [];
    for (const k of keys) {
      let kind = "uns-node";
      try {
        const cd = await eng.call("unsNode", { path: p + "/" + k });
        kind = cd.kind === "dict" ? "uns-dict" : cd.kind === "array" ? "uns-array" : "uns-scalar";
      } catch (_) {}
      out.push({ seg: k, label: k, kind });
    }
    return out;
  }
  return [];
}

function dfChildren(df, idxWord) {
  const list = [{ seg: "__index__", label: `_index (${idxWord})`, kind: "column-string" }];
  for (const c of df.columns || []) list.push({ seg: c.name, label: c.name, kind: "column-" + (c.kind === "group" ? "string" : c.kind) });
  return list;
}

const DRILLABLE = new Set(["dataframe", "mapping", "uns-dict", "group", "uns-node"]);

function viewsFor(kind) {
  switch (kind) {
    case "column-categorical":
    case "column-bool":
      return [["counts", "빈도 표"], ["bar", "막대그래프"], ["preview", "값 미리보기"]];
    case "column-numeric":
      return [["stats", "요약통계"], ["hist", "히스토그램"], ["preview", "값 미리보기"]];
    case "column-string":
      return [["counts", "고유값·빈도"], ["preview", "값 미리보기"]];
    case "matrix":
      return [["slice", "구간 미리보기"], ["minfo", "형태·밀도"]];
    case "vector":
    case "uns-array":
      return [["preview", "값 미리보기"], ["stats", "요약통계"], ["hist", "히스토그램"]];
    case "uns-scalar":
      return [["value", "값"]];
    default:
      return [["preview", "미리보기"]];
  }
}

function matrixAxesForPath(path) {
  const h = path[0];
  if (h === "X" || h === "layers") return { rowAxis: "obs", colAxis: "var" };
  if (h === "obsm" || h === "raw") return { rowAxis: "obs", colAxis: null };
  if (h === "varm") return { rowAxis: "var", colAxis: null };
  if (h === "obsp") return { rowAxis: "obs", colAxis: "obs" };
  if (h === "varp") return { rowAxis: "var", colAxis: "var" };
  return { rowAxis: null, colAxis: null };
}

function pathToEnginePath(path) {
  if (path[0] === "raw") return "raw/" + path.slice(1).join("/");
  return path.join("/");
}

// ---- render ----------------------------------------------------

async function buildExploreTab() {
  await renderMiller();
}

async function renderMiller() {
  millerEl.innerHTML = "";
  let leafReached = false;
  for (let i = 0; i <= state.path.length; i++) {
    const prefix = state.path.slice(0, i);
    let kids;
    try {
      kids = await navChildren(prefix);
    } catch (e) {
      kids = [];
    }
    if (!kids.length) {
      leafReached = i > 0;
      break;
    }
    millerEl.appendChild(millerColumn(kids, i, state.path[i]));
  }
  millerEl.scrollLeft = millerEl.scrollWidth;
  renderBreadcrumb();
  if (leafReached) {
    const entry = await entryFor(state.path);
    if (entry) await showDetail(state.path, entry);
    else clearDetail();
  } else {
    clearDetail();
  }
}

function millerColumn(entries, colIndex, selectedSeg) {
  const col = document.createElement("div");
  col.className = "mcol";
  for (const e of entries) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mitem" + (e.seg === selectedSeg ? " sel" : "");
    const drill = DRILLABLE.has(e.kind);
    b.innerHTML = `<span class="ml">${esc(e.label)}</span>${drill ? '<span class="mr">›</span>' : `<span class="mk">${esc(kindShort(e.kind))}</span>`}`;
    b.addEventListener("click", () => selectSeg(colIndex, e));
    col.appendChild(b);
  }
  return col;
}

function kindShort(kind) {
  if (kind.startsWith("column-")) return kindKo(kind.slice(7));
  if (kind === "matrix") return "행렬";
  if (kind === "vector") return "벡터";
  if (kind === "uns-scalar") return "값";
  if (kind === "uns-array") return "배열";
  return "";
}

async function entryFor(path) {
  if (!path.length) return null;
  const parent = await navChildren(path.slice(0, -1));
  const e = parent.find((x) => x.seg === path[path.length - 1]) || null;
  if (e && e.kind === "uns-node") {
    try {
      const eng = await getEngine();
      const d = await eng.call("unsNode", { path: pathToEnginePath(path) });
      e.kind = d.kind === "array" ? "uns-array" : d.kind === "dict" ? "uns-dict" : "uns-scalar";
    } catch (_) {
      e.kind = "uns-scalar";
    }
  }
  return e;
}

async function selectSeg(colIndex, entry) {
  state.path = state.path.slice(0, colIndex).concat(entry.seg);
  resetViewState();
  await renderMiller();
}

function renderBreadcrumb() {
  if (!state.path.length) {
    breadcrumbEl.innerHTML = `<span class="muted">항목을 선택하세요</span>`;
    return;
  }
  const parts = state.path.map((seg, i) => {
    const label = seg === "__index__" ? "_index" : seg;
    return `<button type="button" data-i="${i}">${esc(label)}</button>`;
  });
  breadcrumbEl.innerHTML = parts.join('<span class="sep">/</span>');
  for (const b of breadcrumbEl.querySelectorAll("button")) {
    b.addEventListener("click", async () => {
      state.path = state.path.slice(0, +b.dataset.i + 1);
      resetViewState();
      await renderMiller();
    });
  }
}

function clearDetail() {
  detailEl.innerHTML = `<p class="muted detail-empty">왼쪽에서 잎(값) 항목을 선택하면 여기에 표시됩니다.</p>`;
}

// ---- detail pane --------------------------------------------

let lastDetail = { key: null, data: null };

async function showDetail(path, entry) {
  const kind = entry.kind;
  const views = viewsFor(kind);
  if (!state.view || !views.some(([v]) => v === state.view)) state.view = views[0][0];

  detailEl.innerHTML = `
    <div class="detail-head">
      <span class="dtitle mono">${esc(path.map((p) => (p === "__index__" ? "_index" : p)).join(" / "))}</span>
      <span class="dkind">${esc(kindShort(kind) || kind)}</span>
      <span class="views">${views.map(([v, l]) => `<button type="button" data-v="${v}"${v === state.view ? ' class="on"' : ""}>${esc(l)}</button>`).join("")}</span>
      <button type="button" id="csvbtn" class="csv" hidden>CSV로 저장</button>
    </div>
    <div id="detail-opts"></div>
    <div id="detail-body"><p class="muted">불러오는 중…</p></div>`;

  for (const b of detailEl.querySelectorAll(".views button")) {
    b.addEventListener("click", () => {
      state.view = b.dataset.v;
      state.previewOffset = 0;
      state.freqOffset = 0;
      showDetail(path, entry);
    });
  }

  const body = el("detail-body");
  const optsBox = el("detail-opts");
  const csvBtn = el("csvbtn");
  let csvRows = null;
  const enableCsv = (rows) => {
    csvRows = rows;
    csvBtn.hidden = !rows;
  };
  csvBtn.addEventListener("click", () => {
    if (csvRows) downloadCSV(`${path.join("_").replace(/[^\w.-]+/g, "_")}_${state.view}.csv`, csvRows);
  });

  try {
    const eng = await getEngine();

    if (kind.startsWith("column-")) {
      const axis = path.slice(0, -1).join("/"); // "obs" | "var" | "raw/var"
      const key = path[path.length - 1];
      const cacheKey = "col:" + path.join("/");
      const d = lastDetail.key === cacheKey ? lastDetail.data : await eng.call("column", { axis, key });
      lastDetail = { key: cacheKey, data: d };
      if (state.view === "preview") {
        await renderColumnPreview(body, axis, key, d, csvBtn, path);
      } else {
        renderColumnView(body, state.view, d);
        enableCsv(csvForColumn(state.view, d));
      }
      return;
    }

    if (kind === "uns-scalar" || kind === "uns-array" || kind === "vector") {
      const ep = pathToEnginePath(path);
      const cacheKey = "uns:" + ep;
      const d = lastDetail.key === cacheKey ? lastDetail.data : await eng.call("unsNode", { path: ep });
      lastDetail = { key: cacheKey, data: d };
      renderUnsView(body, state.view, d, path[path.length - 1]);
      enableCsv(csvForUns(state.view, d));
      return;
    }

    if (kind === "matrix") {
      if (state.view === "minfo") {
        renderMatrixInfo(body, matrixEntryForPath(path), path[path.length - 1]);
        enableCsv(null);
        return;
      }
      const axes = matrixAxesForPath(path);
      await buildSliceControls(optsBox, path, axes);
      await runSlice(body, path, axes, enableCsv);
      return;
    }

    body.innerHTML = `<p class="muted">표시할 내용이 없습니다.</p>`;
  } catch (e) {
    body.innerHTML = `<p class="err">읽기 실패: ${esc(e && e.message ? e.message : e)}</p>`;
  }
}

function matrixEntryForPath(path) {
  const s = openInfo.summary;
  if (path[0] === "X") return s.X;
  if (path[0] === "raw" && path[1] === "X") return s.raw && s.raw.X;
  return (s[path[0]] || {})[path[1]];
}

// ---- paging --------------------------------------------------

function pagerHTML(offset, page, total, unit) {
  const end = Math.min(offset + page, total);
  const atStart = offset <= 0;
  const atEnd = end >= total;
  return `<div class="pager">
    <button data-p="first"${atStart ? " disabled" : ""}>« 처음</button>
    <button data-p="prev"${atStart ? " disabled" : ""}>‹ 이전 ${page}${unit}</button>
    <span>${num(offset + 1)}–${num(end)} / ${num(total)}</span>
    <button data-p="next"${atEnd ? " disabled" : ""}>다음 ${page}${unit} ›</button>
    <button data-p="last"${atEnd ? " disabled" : ""}>끝 »</button>
  </div>`;
}

function wirePager(container, offset, page, total, go) {
  for (const btn of container.querySelectorAll(".pager button")) {
    btn.addEventListener("click", () => {
      const p = btn.dataset.p;
      let n = offset;
      if (p === "first") n = 0;
      else if (p === "prev") n = Math.max(0, offset - page);
      else if (p === "next") n = offset + page;
      else if (p === "last") n = Math.max(0, Math.floor((total - 1) / page) * page);
      if (n !== offset && n >= 0 && n < total) go(n);
    });
  }
}

const PREVIEW_PAGE = 100;

async function renderColumnPreview(body, axis, key, d, csvBtn, path) {
  body.innerHTML = `<p class="muted">불러오는 중…</p>`;
  const eng = await getEngine();
  const off = state.previewOffset || 0;
  const pg = await eng.call("columnPage", { axis, key, offset: off, count: PREVIEW_PAGE });
  const label = key === "__index__" ? "_index" : key;
  body.innerHTML =
    `<p class="vhead"><b>${esc(label)}</b> — ${esc(kindKo(d.kind))} · ${num(pg.n)}개</p>` +
    previewTable(pg.rows, false) +
    pagerHTML(pg.offset, PREVIEW_PAGE, pg.n, "행");
  wirePager(body, pg.offset, PREVIEW_PAGE, pg.n, (n) => {
    state.previewOffset = n;
    renderColumnPreview(body, axis, key, d, csvBtn, path);
  });
  if (csvBtn) {
    csvBtn.hidden = false;
    csvBtn.onclick = () =>
      downloadCSV(`${path.join("_")}_rows_${pg.offset}-${pg.offset + pg.count}.csv`, [["행", "값"], ...pg.rows.map((r) => [r.label, r.value])]);
  }
}

function matrixPager(body, path, axes, cur, shape) {
  const R = shape[0];
  const C = shape.length > 1 ? shape[1] : 1;
  const rEnd = Math.min(cur.r0 + cur.rn, R);
  const cEnd = Math.min(cur.c0 + cur.cn, C);
  const btn = (txt, dis, ax, delta) => `<button ${dis ? "disabled" : ""} data-ax="${ax}" data-d="${delta}">${txt}</button>`;
  const div = document.createElement("div");
  div.className = "pager";
  div.innerHTML =
    `<span>행 ${num(cur.r0 + 1)}–${num(rEnd)} / ${num(R)} ${btn("‹ 이전", cur.r0 <= 0, "r", -cur.rn)}${btn("다음 ›", rEnd >= R, "r", cur.rn)}</span>` +
    `<span>열 ${num(cur.c0 + 1)}–${num(cEnd)} / ${num(C)} ${btn("‹ 이전", cur.c0 <= 0, "c", -cur.cn)}${btn("다음 ›", cEnd >= C, "c", cur.cn)}</span>`;
  for (const b of div.querySelectorAll("button")) {
    b.addEventListener("click", () => {
      const delta = +b.dataset.d;
      if (b.dataset.ax === "r") {
        cur.r0 = Math.min(Math.max(0, R - cur.rn), Math.max(0, cur.r0 + delta));
        if (el("s-r0")) el("s-r0").value = cur.r0;
      } else {
        cur.c0 = Math.min(Math.max(0, C - cur.cn), Math.max(0, cur.c0 + delta));
        if (el("s-c0")) el("s-c0").value = cur.c0;
      }
      state.slice = { ...cur };
      runSlice(el("detail-body"), path, axes, null);
    });
  }
  body.appendChild(div);
}

async function buildSliceControls(box, path, axes) {
  const entry = matrixEntryForPath(path);
  const shp = entry && entry.shape ? entry.shape : [null, null];
  await ensureLabels(axes.rowAxis);
  await ensureLabels(axes.colAxis);
  const rl = axes.rowAxis && labelCache[axes.rowAxis] && !labelCache[axes.rowAxis].tooLarge ? "rowlabels" : "";
  const cl = axes.colAxis && labelCache[axes.colAxis] && !labelCache[axes.colAxis].tooLarge ? "collabels" : "";
  box.innerHTML = `
    <label>행 시작 <input id="s-r0" type="text" value="0" ${rl ? `list="${rl}"` : ""} placeholder="번호 또는 이름"></label>
    <label>행 수 <input id="s-rn" type="number" min="1" max="100" value="20"></label>
    <label>열 시작 <input id="s-c0" type="text" value="0" ${cl ? `list="${cl}"` : ""} placeholder="번호 또는 이름"></label>
    <label>열 수 <input id="s-cn" type="number" min="1" max="60" value="20"></label>
    <button type="button" id="s-go">적용</button>
    <span class="muted" style="align-self:end">전체 ${num(shp[0])} × ${num(shp[1])}</span>
    ${rl ? datalist(rl, labelCache[axes.rowAxis].labels) : ""}
    ${cl ? datalist(cl, labelCache[axes.colAxis].labels) : ""}`;
  el("s-go").addEventListener("click", () => runSlice(el("detail-body"), path, axes, (rows) => {
    const b = el("csvbtn");
    b.hidden = !rows;
    b.__rows = rows;
  }));
}

function datalist(id, labels) {
  const opts = labels.slice(0, 5000).map((l) => `<option value="${esc(l)}">`).join("");
  return `<datalist id="${id}">${opts}</datalist>`;
}

async function ensureLabels(axis) {
  if (!axis || labelCache[axis]) return;
  try {
    const eng = await getEngine();
    const r = await eng.call("axisIndex", { axis });
    if (r.tooLarge) labelCache[axis] = { tooLarge: true, n: r.n };
    else labelCache[axis] = { labels: r.labels, map: new Map(r.labels.map((l, i) => [l, i])), n: r.n };
  } catch (_) {
    labelCache[axis] = { tooLarge: true };
  }
}

function resolveIndex(axis, raw) {
  const t = String(raw).trim();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const c = labelCache[axis];
  if (c && c.map && c.map.has(t)) return c.map.get(t);
  return 0;
}

async function runSlice(body, path, axes, enableCsv) {
  body.innerHTML = `<p class="muted">불러오는 중…</p>`;
  const r0 = Math.max(0, resolveIndex(axes.rowAxis, (el("s-r0") || {}).value ?? 0));
  const c0 = Math.max(0, resolveIndex(axes.colAxis, (el("s-c0") || {}).value ?? 0));
  const rn = Math.min(100, Math.max(1, parseInt((el("s-rn") || {}).value, 10) || 20));
  const cn = Math.min(60, Math.max(1, parseInt((el("s-cn") || {}).value, 10) || 20));
  try {
    const eng = await getEngine();
    const data = await eng.call("matrix", { path: pathToEnginePath(path), r0, rn, c0, cn, ...axes });
    state.slice = { r0, rn, c0, cn };
    renderMatrixSlice(body, data);
    matrixPager(body, path, axes, { r0, rn, c0, cn }, data.shape);
    if (typeof enableCsv === "function") enableCsv(csvForMatrix(data));
    const b = el("csvbtn");
    if (b) {
      b.hidden = false;
      b.__rows = csvForMatrix(data);
      b.onclick = () => downloadCSV(`${path.join("_")}_slice.csv`, b.__rows);
    }
  } catch (e) {
    body.innerHTML = `<p class="err">읽기 실패: ${esc(e && e.message ? e.message : e)}</p>`;
  }
}

// ---- CSV -----------------------------------------------------

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCSV(name, rows) {
  const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function csvForColumn(view, d) {
  if (view === "preview") return [["행", "값"], ...(d.preview || []).map((r) => [r.label, r.value])];
  if (view === "stats") {
    const st = d.stats;
    if (!st || !st.n) return null;
    return [["통계", "값"], ["개수", st.n], ["0의개수", st.nZero], ["최소", st.min], ["25%", st.q1], ["중앙값", st.median], ["75%", st.q3], ["최대", st.max], ["평균", st.mean], ["표준편차", st.std]];
  }
  if (view === "counts" || view === "bar") return [["값", "개수"], ...((d.items || []).map((x) => [x.value, x.count]))];
  return null;
}

function csvForUns(view, d) {
  if (d.kind === "scalar") return [["이름", "값"], ["", d.value]];
  if (d.kind === "array") return [["색인", "값"], ...(d.data || []).map((v, i) => [i, v])];
  return null;
}

function csvForMatrix(d) {
  const [c0, c1] = d.colRange;
  const cols = d.colLabels || Array.from({ length: c1 - c0 }, (_, i) => c0 + i);
  const rows = [["", ...cols]];
  d.rows.forEach((row, i) => rows.push([d.rowLabels ? d.rowLabels[i] : d.rowRange[0] + i, ...row]));
  return rows;
}

// ---- inspect result renderers --------------------------------

function fmtCell(v) {
  if (v === 0) return "0";
  if (typeof v !== "number") return esc(v);
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  if (a < 1e-3 || a >= 1e5) return v.toExponential(2);
  return String(Number(v.toFixed(4)));
}

const FREQ_PAGE = 50;

// Paged value/count list — 이전/다음 through all unique values (sorted by count).
function renderFreqPaged(box, d, headHTML) {
  const items = d.items || [];
  const nUnique = d.nUnique ?? items.length;
  const capped = items.length < nUnique;
  const draw = () => {
    const off = Math.min(state.freqOffset || 0, Math.max(0, Math.floor(Math.max(0, items.length - 1) / FREQ_PAGE) * FREQ_PAGE));
    const pageItems = items.slice(off, off + FREQ_PAGE);
    const rows = pageItems
      .map(
        (r) =>
          `<tr><td>${esc(r.value)}</td><td class="n">${num(r.count)}</td><td class="n">${
            d.total ? ((r.count / d.total) * 100).toFixed(1) + "%" : "—"
          }</td></tr>`,
      )
      .join("");
    box.innerHTML =
      headHTML +
      `<div class="tablescroll"><table class="freq"><thead><tr><th>값</th><th class="n">개수</th><th class="n">비율</th></tr></thead><tbody>${rows}</tbody></table></div>` +
      pagerHTML(off, FREQ_PAGE, items.length, "종") +
      (capped ? `<p class="muted">고유값이 많아 상위 ${num(items.length)}종만 집계했습니다 (실제 ${num(nUnique)}종).</p>` : "");
    wirePager(box, off, FREQ_PAGE, items.length, (n) => {
      state.freqOffset = n;
      draw();
    });
  };
  draw();
}

function renderColumnView(box, view, d) {
  const head = `<p class="vhead"><b>${esc(d.key)}</b> — ${esc(kindKo(d.kind))} · ${num(d.n)}개${
    d.approx ? " <span class='muted'>(표본 기준 근사)</span>" : ""
  }${d.nMissing ? ` · 결측 ${num(d.nMissing)}` : ""}${d.nUnique != null ? ` · 고유값 ${num(d.nUnique)}` : ""}</p>`;
  if (view === "counts") {
    renderFreqPaged(box, d, head);
    return;
  }
  let body = "";
  if (view === "bar") body = barChartSVG(d.items || []);
  else if (view === "stats") body = statsTable(d.stats);
  else if (view === "hist") body = d.histogram ? histogramSVG(d.histogram) + (d.histogram.single != null ? `<p class="muted">모든 값이 ${fmtCell(d.histogram.single)} 입니다.</p>` : "") : `<p class="muted">히스토그램을 만들 수 없습니다.</p>`;
  else if (view === "preview") body = previewTable(d.preview || []);
  box.innerHTML = head + body;
}

function statsTable(st) {
  if (!st || !st.n) return `<p class="muted">수치 값이 없습니다.</p>`;
  const rows = [
    ["개수", num(st.n)],
    ["0의 개수", num(st.nZero)],
    ["최소", fmtCell(st.min)],
    ["25%", fmtCell(st.q1)],
    ["중앙값", fmtCell(st.median)],
    ["75%", fmtCell(st.q3)],
    ["최대", fmtCell(st.max)],
    ["평균", fmtCell(st.mean)],
    ["표준편차", fmtCell(st.std)],
  ];
  return `<table class="kv">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</table>`;
}

function previewTable(rows, footer = true) {
  if (!rows.length) return `<p class="muted">표시할 값이 없습니다.</p>`;
  const body = rows.map((r) => `<tr><td class="mono">${esc(r.label)}</td><td class="n">${fmtCell(r.value)}</td></tr>`).join("");
  return `<div class="tablescroll"><table class="freq"><thead><tr><th>행</th><th class="n">값</th></tr></thead><tbody>${body}</tbody></table></div>${
    footer ? `<p class="muted">앞 ${rows.length}개</p>` : ""
  }`;
}

function renderUnsView(box, view, d, label) {
  if (d.kind === "scalar") {
    box.innerHTML = `<p class="vhead"><b>${esc(label)}</b> = ${esc(d.value)} <span class="muted">(${esc(d.dtype)})</span></p>`;
    return;
  }
  if (d.kind === "dict") {
    box.innerHTML = `<p class="vhead"><b>${esc(label)}</b> — 그룹</p><ul class="items">${(d.keys || []).map((k) => `<li class="mono">${esc(k)}</li>`).join("")}</ul>`;
    return;
  }
  // array / vector
  const head = `<p class="vhead"><b>${esc(label)}</b> — 배열 [${(d.shape || []).join(" × ")}] · ${esc(d.dtype)}${d.approx ? " <span class='muted'>(앞부분만)</span>" : ""}</p>`;
  let body = "";
  if (view === "stats") body = statsTable(d.stats);
  else if (view === "hist") body = d.histogram && d.histogram.counts && d.histogram.counts.length ? histogramSVG(d.histogram) : `<p class="muted">히스토그램을 만들 수 없습니다.</p>`;
  else body = `<div class="tablescroll"><table class="freq"><tbody>${(d.data || []).slice(0, 200).map((v, i) => `<tr><td class="mono">${i}</td><td class="n">${esc(v)}</td></tr>`).join("")}</tbody></table></div>`;
  box.innerHTML = head + body;
}

function renderMatrixInfo(box, entry, label) {
  if (!entry) {
    box.innerHTML = `<p class="muted">정보가 없습니다.</p>`;
    return;
  }
  const rows = [
    ["형태", Array.isArray(entry.shape) ? entry.shape.map(num).join(" × ") : "—"],
    ["형식", FORMAT_KO[entry.format] || entry.format || "—"],
    ["자료형", entry.dtype || "—"],
    ["0이 아닌 값(nnz)", entry.nnz != null ? num(entry.nnz) : "—"],
    ["밀도", entry.density != null ? pct(entry.density) : "—"],
  ];
  box.innerHTML = `<p class="vhead"><b>${esc(label)}</b></p><table class="kv">${rows
    .map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`)
    .join("")}</table>`;
}

function renderMatrixSlice(box, d) {
  const [r0, r1] = d.rowRange;
  const [c0, c1] = d.colRange;
  const colLabels = d.colLabels || Array.from({ length: c1 - c0 }, (_, i) => String(c0 + i));
  const rowLabels = d.rowLabels || Array.from({ length: r1 - r0 }, (_, i) => String(r0 + i));
  const thead = `<thead><tr><th></th>${colLabels.map((l) => `<th>${esc(l)}</th>`).join("")}</tr></thead>`;
  const tbody = d.rows
    .map(
      (row, ri) =>
        `<tr><th>${esc(rowLabels[ri] ?? r0 + ri)}</th>${row
          .map((v) => `<td class="${v === 0 ? "z" : ""}">${fmtCell(v)}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  box.innerHTML = `<p class="vhead">행 ${num(r0)}–${num(r1 - 1)} × 열 ${num(c0)}–${num(c1 - 1)} · 전체 ${num(d.shape[0])} × ${num(
    d.shape[1],
  )} · ${esc(FORMAT_KO[d.format] || d.format)}</p><div class="tablescroll"><table class="matrix">${thead}<tbody>${tbody}</tbody></table></div>`;
}

// ---- dataframe (obs / var) --------------------------------------

function dataframeSection(title, df, rowWord) {
  const sec = document.createElement("section");
  sec.className = "card";
  if (!df) {
    sec.innerHTML = `<h2>${esc(title)}</h2><p class="muted">${esc(title)} 없음.</p>`;
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
    <p class="prose">${esc(rowWord)} ${num(df.nRows)}개 · 인덱스 <span class="mono">${esc(df.indexName)}</span>
      — ${esc(kindKo(idx.kind || "string"))}${idx.nullable ? ", 결측 허용" : ""}.</p>
    ${
      df.columns.length
        ? `<table class="grid"><thead><tr><th>컬럼</th><th>종류</th><th>자료형</th><th>비고</th></tr></thead><tbody>${rows}</tbody></table>`
        : `<p class="muted">추가 컬럼 없음 — 인덱스(이름)만 존재.</p>`
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
      if (!keys.length) return `<div class="mapblock"><h3>${name}</h3><p class="muted">없음.</p></div>`;
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
    sec.innerHTML = `<h2>비정형 데이터 (uns)</h2><p class="muted">없음.</p>`;
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
    <p class="prose">정규화 이전 원본 카운트. <span class="mono">raw.X</span> / <span class="mono">raw.var</span> 로 접근.</p>
    <table class="kv">
      <tr><th>raw.X</th><td>${X ? `${esc(FORMAT_KO[X.format] || X.format)} ${shapeStr(X.shape)} · ${esc(X.dtype || "?")}${X.density != null ? " · 밀도 " + pct(X.density) : ""}` : "없음"}</td></tr>
      <tr><th>raw.var</th><td>${raw.var ? `${num(raw.var.nRows)} 유전자 · ${num(raw.var.nColumns)} 컬럼` : "없음"}</td></tr>
    </table>`;
  return sec;
}

// ---- raw HDF5 tree (구조 tab) ---------------------------------

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

// Prefer the File System Access API so the native dialog's confirm button reads
// "열기" / "폴더 선택" rather than "업로드"; fall back to a classic <input> on
// browsers without it (Firefox, Safari).
const H5_ACCEPT = { description: "AnnData / HDF5", accept: { "application/octet-stream": [".h5ad", ".h5", ".hdf5"] } };

async function pickFile() {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({ multiple: false, types: [H5_ACCEPT], excludeAcceptAllOption: false });
      handleFile(await handle.getFile());
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return; // cancelled
      // any other error → fall back to the classic input below
    }
  }
  fileInput.value = "";
  fileInput.click();
}

async function pickFolder() {
  if (window.showDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker();
      const files = [];
      const walk = async (handle, prefix) => {
        for await (const entry of handle.values()) {
          if (entry.kind === "file") {
            const f = await entry.getFile();
            try {
              Object.defineProperty(f, "relPath", { value: prefix + entry.name });
            } catch (_) {}
            files.push(f);
          } else if (entry.kind === "directory") {
            await walk(entry, prefix + entry.name + "/");
          }
        }
      };
      await walk(dir, dir.name + "/");
      scanFolder(files);
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
  }
  folderInput.value = "";
  folderInput.click();
}

fileInput.addEventListener("change", () => handleFile(fileInput.files[0]));
openBtn.addEventListener("click", pickFile);
el("filebar-change").addEventListener("click", pickFile);
scanBtn.addEventListener("click", pickFolder);
folderInput.addEventListener("change", () => {
  const files = Array.from(folderInput.files || []);
  if (files.length) scanFolder(files);
});

for (const b of topnav.querySelectorAll("button")) {
  b.addEventListener("click", () => setTab(b.dataset.tab));
}

// Drop a file anywhere on the window to open it — also while one is already
// loaded (it reloads with the dropped file). Uses a re-armed timer instead of
// an enter/leave counter so the overlay never gets stuck.
let dragHideTimer = 0;
const hasFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");

function armDragOverlay() {
  document.body.classList.add("dragging");
  clearTimeout(dragHideTimer);
  dragHideTimer = setTimeout(() => document.body.classList.remove("dragging"), 150);
}
function clearDragOverlay() {
  clearTimeout(dragHideTimer);
  document.body.classList.remove("dragging");
}

for (const type of ["dragenter", "dragover"]) {
  window.addEventListener(type, (e) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault(); // required, or the browser navigates to the file
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    armDragOverlay();
  });
}
window.addEventListener("dragend", clearDragOverlay);
window.addEventListener("drop", (e) => {
  if (!hasFileDrag(e) && !e.dataTransfer?.files?.length) return;
  e.preventDefault();
  clearDragOverlay();
  // grab entries synchronously — dataTransfer is cleared once the handler returns
  const items = e.dataTransfer?.items ? Array.from(e.dataTransfer.items) : [];
  const entries = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
  if (entries.some((en) => en.isDirectory)) {
    filesFromEntries(entries).then((files) => scanFolder(files));
    return;
  }
  const files = Array.from(e.dataTransfer?.files || []);
  const f = files.find((x) => H5_RE.test(x.name)) || files[0];
  if (f) handleFile(f);
});

// ---- resizable columns in the detail pane -------------------

// Add drag handles to a table's column dividers. The table keeps its natural
// auto layout (full values, fit-content width) until the user actually starts
// dragging — only then do we lock explicit widths + table-layout:fixed.
function enhanceResizable(table) {
  if (table.dataset.rz) return;
  const head = (table.tHead && table.tHead.rows[0]) || table.rows[0];
  if (!head || head.cells.length < 2) return;
  table.dataset.rz = "1";
  const cells = [...head.cells];
  let locked = false;

  const lock = () => {
    if (locked) return true;
    const widths = cells.map((c) => Math.round(c.getBoundingClientRect().width));
    if (widths.some((w) => w < 1)) return false;
    cells.forEach((c, i) => (c.style.width = widths[i] + "px"));
    table.classList.add("rz");
    table.style.width = widths.reduce((a, b) => a + b, 0) + "px";
    locked = true;
    return true;
  };
  const unlock = () => {
    cells.forEach((c) => (c.style.width = ""));
    table.classList.remove("rz");
    table.style.width = "";
    locked = false;
  };

  cells.forEach((th, i) => {
    if (getComputedStyle(th).position === "static") th.style.position = "relative";
    if (i === cells.length - 1) return;
    const grip = document.createElement("span");
    grip.className = "col-grip";
    grip.title = "드래그: 열 너비 조절 · 더블클릭: 자동 맞춤";
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!lock()) return;
      const x0 = e.clientX;
      const w0 = th.getBoundingClientRect().width;
      try {
        grip.setPointerCapture(e.pointerId);
      } catch (_) {}
      document.body.classList.add("col-resizing");
      const move = (ev) => {
        th.style.width = Math.max(40, Math.round(w0 + ev.clientX - x0)) + "px";
        table.style.width = cells.reduce((a, c) => a + c.getBoundingClientRect().width, 0) + "px";
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        document.body.classList.remove("col-resizing");
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    });
    grip.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      unlock();
    });
    th.appendChild(grip);
  });
}

const RZ_SEL = "table.freq:not([data-rz]), table.kv:not([data-rz])";
function enhanceIn(root) {
  if (!root) return;
  for (const t of root.querySelectorAll(RZ_SEL)) enhanceResizable(t);
}
const rzObserver = new MutationObserver(() => enhanceIn(detailEl));
rzObserver.observe(detailEl, { childList: true, subtree: true });

setStatus("", "info");
