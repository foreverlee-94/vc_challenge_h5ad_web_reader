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
    const info = await eng.call("open", { file }, (msg) => setStatus(`${file.name} — ${msg}`, "info"));
    const ms = Math.round(performance.now() - t0);
    render(info, ms);
    setStatus(`열림: ${file.name} · ${ms} ms${eng.mode === "main" ? " · 메인 스레드 모드(파일 전체 메모리 로드)" : ""}`, "ok");
  } catch (err) {
    setStatus(`열기 실패: ${err && err.message ? err.message : err}`, "error");
  }
}

function render(info, ms) {
  const { file, summary, tree } = info;
  currentSummary = summary;
  reportBox.innerHTML = "";
  reportBox.append(
    overviewCard(file, summary, ms),
    inspectSection(summary),
    dataframeSection("세포 정보 (obs)", summary.obs, "세포", "유전자 이름 외 추가 컬럼이 없습니다."),
    dataframeSection("유전자 정보 (var)", summary.var, "유전자", "추가 컬럼이 없습니다 (유전자 이름만)."),
    mappingSection(summary),
    unsSection(summary.uns),
  );
  if (summary.raw) reportBox.append(rawSection(summary.raw));
  reportBox.append(advancedTree(tree));
  reportBox.hidden = false;
}

let currentSummary = null;

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

// ---- inspect panel: component -> key -> view -------------------

let inspectKeysCache = [];

function inspectComponents(s) {
  const out = [];
  if (s.obs && (s.obs.columns.length || s.obs.nRows)) out.push({ id: "obs", label: "세포 정보 (obs)" });
  if (s.var && (s.var.columns.length || s.var.nRows)) out.push({ id: "var", label: "유전자 정보 (var)" });
  if (s.X) out.push({ id: "X", label: "발현 행렬 X" });
  for (const m of ["layers", "obsm", "varm", "obsp", "varp"]) if (Object.keys(s[m] || {}).length) out.push({ id: m, label: m });
  if (Object.keys(s.uns || {}).filter((k) => k !== "__truncated__").length) out.push({ id: "uns", label: "비정형 데이터 (uns)" });
  if (s.raw && s.raw.X) out.push({ id: "raw.X", label: "raw.X" });
  return out;
}

function unsLeaves(node, prefix = "") {
  const out = [];
  for (const k of Object.keys(node || {})) {
    if (k === "__truncated__") continue;
    const v = node[k];
    const path = prefix ? `${prefix}/${k}` : k;
    if (v.kind === "dict") {
      if (v.children) out.push(...unsLeaves(v.children, path));
      else out.push({ path, kind: "dict" });
    } else out.push({ path, kind: v.kind });
  }
  return out;
}

function inspectKeysFor(s, comp) {
  if (comp === "obs" || comp === "var") {
    const df = s[comp];
    const list = [{ value: "__index__", label: comp === "obs" ? "_index (세포 이름)" : "_index (유전자 이름)", kind: "string" }];
    for (const c of df.columns) list.push({ value: c.name, label: c.name, kind: c.kind === "group" ? "string" : c.kind });
    return list;
  }
  if (comp === "X") return [{ value: "X", label: "(전체 행렬)", kind: "matrix" }];
  if (comp === "raw.X") return [{ value: "raw/X", label: "(전체 행렬)", kind: "matrix" }];
  if (comp === "uns") return unsLeaves(s.uns).map((p) => ({ value: p.path, label: p.path, kind: "uns-" + p.kind }));
  const map = s[comp] || {};
  return Object.entries(map).map(([k, v]) => {
    let kind = "matrix";
    if (v.format === "dense") kind = Array.isArray(v.shape) && v.shape.length === 1 ? "vector" : "matrix";
    else if (v.format === "group") kind = "group";
    return { value: k, label: k, kind };
  });
}

function inspectViewsFor(kind) {
  switch (kind) {
    case "categorical":
    case "bool":
      return [["counts", "빈도 표"], ["bar", "막대그래프"], ["preview", "값 미리보기"]];
    case "numeric":
    case "vector":
    case "uns-array":
      return [["stats", "요약통계"], ["hist", "히스토그램"], ["preview", "값 미리보기"]];
    case "string":
      return [["counts", "고유값·빈도"], ["preview", "값 미리보기"]];
    case "matrix":
      return [["slice", "구간 미리보기"], ["minfo", "형태·밀도"]];
    case "uns-scalar":
      return [["value", "값"]];
    case "uns-dict":
    case "group":
      return [["ginfo", "내용 목록"]];
    default:
      return [["preview", "미리보기"]];
  }
}

function matrixAxes(comp) {
  if (comp === "X" || comp === "layers") return { rowAxis: "obs", colAxis: "var" };
  if (comp === "obsm" || comp === "raw.X") return { rowAxis: "obs", colAxis: null };
  if (comp === "varm") return { rowAxis: "var", colAxis: null };
  if (comp === "obsp") return { rowAxis: "obs", colAxis: "obs" };
  if (comp === "varp") return { rowAxis: "var", colAxis: "var" };
  return { rowAxis: null, colAxis: null };
}

function optionEls(list) {
  return list.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("");
}

function inspectSection(s) {
  const sec = document.createElement("section");
  sec.className = "card";
  const comps = inspectComponents(s);
  if (!comps.length) {
    sec.innerHTML = `<h2>항목 살펴보기</h2><p class="muted">살펴볼 항목이 없습니다.</p>`;
    return sec;
  }
  sec.innerHTML = `
    <h2>항목 살펴보기</h2>
    <p class="muted">구성요소 → 항목 → 보기 방식을 골라 실제 값을 확인하세요.</p>
    <div class="pickers">
      <label>구성요소<select id="pk-comp">${optionEls(comps.map((c) => ({ value: c.id, label: c.label })))}</select></label>
      <label>항목<select id="pk-key"></select></label>
      <label>보기<select id="pk-view"></select></label>
    </div>
    <div id="pk-opts"></div>
    <div><button id="pk-run" type="button">확인</button></div>
    <div id="pk-result"></div>`;

  const compSel = sec.querySelector("#pk-comp");
  const keySel = sec.querySelector("#pk-key");
  const viewSel = sec.querySelector("#pk-view");
  const optsBox = sec.querySelector("#pk-opts");
  const resultBox = sec.querySelector("#pk-result");

  const currentKey = () => inspectKeysCache.find((k) => k.value === keySel.value);

  function refillKeys() {
    inspectKeysCache = inspectKeysFor(s, compSel.value);
    keySel.innerHTML = optionEls(inspectKeysCache);
    refillViews();
  }
  function refillViews() {
    const k = currentKey();
    const views = inspectViewsFor(k ? k.kind : "");
    viewSel.innerHTML = views.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("");
    refillOpts();
  }
  function refillOpts() {
    const k = currentKey();
    if (k && k.kind === "matrix" && viewSel.value === "slice") {
      const entry = matrixEntry(s, compSel.value, k.value);
      const shp = entry && entry.shape ? entry.shape : [null, null];
      optsBox.innerHTML = `
        <label>행 시작<input id="pk-r0" type="number" min="0" value="0"></label>
        <label>행 수<input id="pk-rn" type="number" min="1" max="100" value="20"></label>
        <label>열 시작<input id="pk-c0" type="number" min="0" value="0"></label>
        <label>열 수<input id="pk-cn" type="number" min="1" max="60" value="20"></label>
        <span class="muted" style="align-self:end">전체 ${num(shp[0])} × ${num(shp[1])}</span>`;
    } else {
      optsBox.innerHTML = "";
    }
  }

  function readSliceInputs() {
    const g = (id, d) => {
      const n = parseInt((sec.querySelector(id) || {}).value, 10);
      return Number.isFinite(n) ? n : d;
    };
    return {
      r0: Math.max(0, g("#pk-r0", 0)),
      rn: Math.min(100, Math.max(1, g("#pk-rn", 20))),
      c0: Math.max(0, g("#pk-c0", 0)),
      cn: Math.min(60, Math.max(1, g("#pk-cn", 20))),
    };
  }

  async function run() {
    const comp = compSel.value;
    const k = currentKey();
    const view = viewSel.value;
    if (!comp || !k || !view) return;
    resultBox.innerHTML = `<p class="muted">불러오는 중…</p>`;
    try {
      const eng = await getEngine();
      if (comp === "obs" || comp === "var") {
        renderColumnView(resultBox, view, await eng.call("column", { axis: comp, key: k.value }));
      } else if (comp === "uns") {
        renderUnsView(resultBox, view, await eng.call("unsNode", { path: "uns/" + k.value }), k.value);
      } else if (k.kind === "vector" || k.kind === "group") {
        renderUnsView(resultBox, view, await eng.call("unsNode", { path: `${comp}/${k.value}` }), k.value);
      } else if (view === "minfo") {
        renderMatrixInfo(resultBox, matrixEntry(s, comp, k.value), k.value);
      } else {
        const path = comp === "X" ? "X" : comp === "raw.X" ? "raw/X" : `${comp}/${k.value}`;
        const data = await eng.call("matrix", { path, ...readSliceInputs(), ...matrixAxes(comp) });
        renderMatrixSlice(resultBox, data);
      }
    } catch (e) {
      resultBox.innerHTML = `<p class="err">읽기 실패: ${esc(e && e.message ? e.message : e)}</p>`;
    }
  }

  compSel.addEventListener("change", () => {
    refillKeys();
    run();
  });
  keySel.addEventListener("change", () => {
    refillViews();
    run();
  });
  viewSel.addEventListener("change", () => {
    refillOpts();
    run();
  });
  sec.querySelector("#pk-run").addEventListener("click", run);

  refillKeys();
  return sec;
}

function matrixEntry(s, comp, key) {
  if (comp === "X") return s.X;
  if (comp === "raw.X") return s.raw && s.raw.X;
  return (s[comp] || {})[key];
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

function freqTable(items, more, total) {
  const rows = items
    .map(
      (r) =>
        `<tr><td>${esc(r.value)}</td><td class="n">${num(r.count)}</td><td class="n">${total ? ((r.count / total) * 100).toFixed(1) + "%" : "—"}</td></tr>`,
    )
    .join("");
  return `<table class="freq"><thead><tr><th>값</th><th class="n">개수</th><th class="n">비율</th></tr></thead><tbody>${rows}</tbody></table>${
    more ? `<p class="muted">… 그 외 ${num(more)}개</p>` : ""
  }`;
}

function renderColumnView(box, view, d) {
  const head = `<p class="vhead"><b>${esc(d.key)}</b> — ${esc(kindKo(d.kind))} · ${num(d.n)}개${
    d.approx ? " <span class='muted'>(표본 기준 근사)</span>" : ""
  }${d.nMissing ? ` · 결측 ${num(d.nMissing)}` : ""}${d.nUnique != null ? ` · 고유값 ${num(d.nUnique)}` : ""}</p>`;
  let body = "";
  if (view === "counts") body = freqTable(d.items || [], d.more, d.total || d.n);
  else if (view === "bar") body = barChartSVG(d.items || []);
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

function previewTable(rows) {
  if (!rows.length) return `<p class="muted">표시할 값이 없습니다.</p>`;
  const body = rows.map((r) => `<tr><td class="mono">${esc(r.label)}</td><td class="n">${fmtCell(r.value)}</td></tr>`).join("");
  return `<div class="tablescroll"><table class="freq"><thead><tr><th>행</th><th class="n">값</th></tr></thead><tbody>${body}</tbody></table></div><p class="muted">앞 ${rows.length}개</p>`;
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
