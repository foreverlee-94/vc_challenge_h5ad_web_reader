// Read operations: pull actual values out of an open h5wasm File.
// Shared by worker.mjs and mainengine.mjs. Keeps reads bounded (samples large
// vectors, slices matrices) so a huge file never forces a full decompress.

import { isGroup, attr, encodingOf, child, normAttr, typeInfo } from "./anndata.mjs";
import { numericStats, histogram, valueCounts } from "./stats.mjs";

const VEC_CAP = 200000; // above this, sample instead of full read
const PREVIEW = 100;

function toArr(v) {
  return Array.from(v, (x) => (typeof x === "bigint" ? Number(x) : x));
}

// Full or evenly-block-sampled 1-D read.
function readVec(ds) {
  const n = normAttr(ds.shape)[0] ?? 0;
  if (n <= VEC_CAP) return { data: toArr(ds.value), n, approx: false };
  const blocks = 200;
  const blockSize = Math.max(1, Math.floor(VEC_CAP / blocks));
  const out = [];
  for (let b = 0; b < blocks; b++) {
    const start = Math.min(n - blockSize, Math.floor(((n - blockSize) * b) / (blocks - 1)));
    const s = Math.max(0, start);
    out.push(...toArr(ds.slice([[s, s + blockSize]])));
  }
  return { data: out, n, approx: true };
}

// ---- axis labels (obs/var index) ----------------------------------

function indexDataset(file, axis) {
  const grp = file.get(axis);
  const indexName = attr(grp, "_index") || "_index";
  const node = child(grp, indexName);
  return isGroup(node) ? child(node, "values") : node;
}

export function axisLabels(file, axis, start, count) {
  const ds = indexDataset(file, axis);
  if (!ds) return null;
  const n = normAttr(ds.shape)[0];
  const s = Math.max(0, Math.min(start | 0, n));
  const e = Math.max(s, Math.min(s + (count | 0), n));
  return { labels: Array.from(ds.slice([[s, e]]), String), start: s, n };
}

// Full index for name -> row/col lookup in the UI. Skipped for very large axes.
export function axisIndex(file, axis, cap = 300000) {
  const ds = indexDataset(file, axis);
  if (!ds) return { n: 0, labels: [] };
  const n = normAttr(ds.shape)[0];
  if (n > cap) return { n, tooLarge: true };
  return { n, labels: Array.from(ds.value, String) };
}

// ---- column reader ------------------------------------------------

export function readColumn(file, axis, key) {
  const grp = file.get(axis);
  if (!grp) throw new Error(`${axis} 없음`);
  const indexName = attr(grp, "_index") || "_index";
  const isIndex = key === "__index__" || key === indexName;
  const name = isIndex ? indexName : key;
  const node = child(grp, name);
  if (!node) throw new Error(`${axis}/${name} 없음`);

  let result = { axis, key: name, isIndex };
  const head = () => columnPage(file, axis, name, 0, PREVIEW).rows;

  if (isGroup(node)) {
    const enc = encodingOf(node);
    if (enc === "categorical") {
      const cats = toArr(child(node, "categories").value).map(String);
      const { data: codes, n, approx } = readVec(child(node, "codes"));
      const labels = codes.map((c) => (c < 0 || c >= cats.length ? "(결측)" : cats[c]));
      const vc = valueCounts(labels, 5000);
      result = { ...result, kind: "categorical", n, approx, ordered: !!attr(node, "ordered"), nCategories: cats.length, ...vc };
      result.preview = head();
      return result;
    }
    if (enc === "nullable-integer" || enc === "nullable-boolean") {
      const { data: vals, n, approx } = readVec(child(node, "values"));
      const mask = readVec(child(node, "mask")).data;
      let nMissing = 0;
      const clean = vals.map((v, i) => (mask[i] ? (nMissing++, NaN) : v));
      if (enc === "nullable-boolean") {
        const labels = clean.map((v) => (Number.isNaN(v) ? "(결측)" : v ? "참" : "거짓"));
        result = { ...result, kind: "bool", n, approx, nMissing, ...valueCounts(labels, 10) };
      } else {
        result = { ...result, kind: "numeric", n, approx, nMissing, stats: numericStats(clean), histogram: histogram(clean) };
      }
      result.preview = head();
      return result;
    }
    if (enc === "nullable-string-array" || enc === "string-array") {
      const { data: vals, n, approx } = readVec(child(node, "values"));
      const maskDs = child(node, "mask");
      let nMissing = 0;
      const clean = vals.map((v, i) => v);
      if (maskDs) {
        const mask = readVec(maskDs).data;
        for (let i = 0; i < clean.length; i++) if (mask[i]) (clean[i] = "(결측)"), nMissing++;
      }
      result = { ...result, kind: "string", n, approx, nMissing, ...valueCounts(clean.map(String), 5000) };
      result.preview = head();
      return result;
    }
    throw new Error(`지원하지 않는 컬럼 인코딩: ${enc}`);
  }

  // plain dataset column
  const ti = typeInfo(node.metadata);
  const { data: vals, n, approx } = readVec(node);
  if (ti.cls === "numeric") {
    result = { ...result, kind: "numeric", n, approx, nMissing: 0, stats: numericStats(vals), histogram: histogram(vals) };
  } else if (ti.cls === "bool") {
    const labels = vals.map((v) => (v ? "참" : "거짓"));
    result = { ...result, kind: "bool", n, approx, nMissing: 0, ...valueCounts(labels, 10) };
  } else {
    const s = vals.map(String);
    result = { ...result, kind: "string", n, approx, nMissing: 0, ...valueCounts(s, 5000) };
  }
  result.preview = head();
  return result;
}

// One page of a column's raw values, aligned to real row indices [offset, offset+count).
export function columnPage(file, axis, key, offset = 0, count = 100) {
  const grp = file.get(axis);
  if (!grp) throw new Error(`${axis} 없음`);
  const indexName = attr(grp, "_index") || "_index";
  const name = key === "__index__" || key === indexName ? indexName : key;
  const node = child(grp, name);
  if (!node) throw new Error(`${axis}/${name} 없음`);

  let total;
  let valSlice;

  if (isGroup(node)) {
    const enc = encodingOf(node);
    if (enc === "categorical") {
      const cats = toArr(child(node, "categories").value).map(String);
      const codesDs = child(node, "codes");
      total = normAttr(codesDs.shape)[0];
      valSlice = (s, e) => toArr(codesDs.slice([[s, e]])).map((c) => (c < 0 || c >= cats.length ? "(결측)" : cats[c]));
    } else if (["nullable-integer", "nullable-boolean", "nullable-string-array", "string-array"].includes(enc)) {
      const valuesDs = child(node, "values");
      const maskDs = child(node, "mask");
      const isBool = enc === "nullable-boolean";
      total = normAttr(valuesDs.shape)[0];
      valSlice = (s, e) => {
        const vs = toArr(valuesDs.slice([[s, e]]));
        const ms = maskDs ? toArr(maskDs.slice([[s, e]])) : null;
        return vs.map((v, k) => (ms && ms[k] ? "(결측)" : isBool ? (v ? "참" : "거짓") : v));
      };
    } else {
      throw new Error(`지원하지 않는 컬럼 인코딩: ${enc}`);
    }
  } else {
    total = normAttr(node.shape)[0];
    const ti = typeInfo(node.metadata);
    valSlice = (s, e) => {
      const vs = toArr(node.slice([[s, e]]));
      return ti.cls === "bool" ? vs.map((v) => (v ? "참" : "거짓")) : vs;
    };
  }

  const s = Math.max(0, Math.min(offset | 0, total));
  const e = Math.max(s, Math.min(s + (count | 0), total));
  const idxDs = indexDataset(file, axis);
  let labels = null;
  try {
    labels = Array.from(idxDs.slice([[s, e]]), String);
  } catch (_) {}
  const rows = valSlice(s, e).map((v, k) => ({ i: s + k, label: labels ? labels[k] : String(s + k), value: v }));
  return { offset: s, count: e - s, n: total, rows };
}

// ---- matrix slice ------------------------------------------------

export function readMatrixSlice(file, path, r0, rn, c0, cn) {
  const node = file.get(path);
  if (!node) throw new Error(`${path} 없음`);
  const enc = isGroup(node) ? encodingOf(node) : null;

  if (enc === "csr_matrix" || enc === "csc_matrix") {
    const shape = normAttr(attr(node, "shape"));
    const [R, C] = shape;
    r0 = clamp(r0, 0, R);
    c0 = clamp(c0, 0, C);
    rn = clamp(rn, 0, R - r0);
    cn = clamp(cn, 0, C - c0);
    const indptr = child(node, "indptr");
    const dataDs = child(node, "data");
    const idxDs = child(node, "indices");
    const rows = Array.from({ length: rn }, () => new Array(cn).fill(0));

    if (enc === "csr_matrix") {
      const ip = toArr(indptr.slice([[r0, r0 + rn + 1]]));
      for (let k = 0; k < rn; k++) {
        const s = ip[k],
          e = ip[k + 1];
        if (e <= s) continue;
        const cols = toArr(idxDs.slice([[s, e]]));
        const vals = toArr(dataDs.slice([[s, e]]));
        for (let j = 0; j < cols.length; j++) {
          const col = cols[j];
          if (col >= c0 && col < c0 + cn) rows[k][col - c0] = vals[j];
        }
      }
    } else {
      const ip = toArr(indptr.slice([[c0, c0 + cn + 1]]));
      for (let k = 0; k < cn; k++) {
        const s = ip[k],
          e = ip[k + 1];
        if (e <= s) continue;
        const rws = toArr(idxDs.slice([[s, e]]));
        const vals = toArr(dataDs.slice([[s, e]]));
        for (let j = 0; j < rws.length; j++) {
          const row = rws[j];
          if (row >= r0 && row < r0 + rn) rows[row - r0][k] = vals[j];
        }
      }
    }
    return { format: enc === "csr_matrix" ? "csr" : "csc", shape, rowRange: [r0, r0 + rn], colRange: [c0, c0 + cn], rows };
  }

  // dense dataset
  const shape = normAttr(node.shape);
  const R = shape[0],
    C = shape.length > 1 ? shape[1] : 1;
  r0 = clamp(r0, 0, R);
  c0 = clamp(c0, 0, C);
  rn = clamp(rn, 0, R - r0);
  cn = clamp(cn, 0, C - c0);
  const flat = shape.length > 1 ? node.slice([[r0, r0 + rn], [c0, c0 + cn]]) : node.slice([[r0, r0 + rn]]);
  const arr = toArr(flat);
  const rows = [];
  for (let k = 0; k < rn; k++) rows.push(arr.slice(k * cn, k * cn + cn));
  return { format: "dense", shape, rowRange: [r0, r0 + rn], colRange: [c0, c0 + cn], rows };
}

function clamp(v, lo, hi) {
  v = v | 0;
  return v < lo ? lo : v > hi ? hi : v;
}

// engine wrapper: slice + attach row/col labels
export function matrixWithLabels(file, p) {
  const slice = readMatrixSlice(file, p.path, p.r0 ?? 0, p.rn ?? 20, p.c0 ?? 0, p.cn ?? 20);
  const rowLabels = p.rowAxis ? (axisLabels(file, p.rowAxis, slice.rowRange[0], slice.rows.length) || {}).labels : null;
  const colLabels = p.colAxis ? (axisLabels(file, p.colAxis, slice.colRange[0], slice.colRange[1] - slice.colRange[0]) || {}).labels : null;
  return { ...slice, rowLabels, colLabels };
}

// ---- uns node --------------------------------------------------

export function readUnsNode(file, path) {
  const node = file.get(path);
  if (!node) throw new Error(`${path} 없음`);
  if (isGroup(node)) return { kind: "dict", keys: node.keys() };
  const shape = normAttr(node.shape);
  const dtype = typeInfo(node.metadata).dtype;
  if (Array.isArray(shape) && shape.length === 0) {
    let value;
    try {
      value = node.value;
      if (typeof value === "bigint") value = Number(value);
    } catch (e) {
      value = `<${e.message}>`;
    }
    return { kind: "scalar", dtype, value };
  }
  const total = shape.reduce((a, b) => a * b, 1);
  const CAP = 5000;
  let data,
    approx = false;
  if (total <= CAP) data = toArr(node.value);
  else {
    data = toArr(node.slice([[0, CAP]]));
    approx = true;
  }
  const numeric = typeInfo(node.metadata).cls === "numeric";
  return {
    kind: "array",
    shape,
    dtype,
    approx,
    data: data.slice(0, CAP).map(String),
    stats: numeric ? numericStats(data) : null,
    histogram: numeric ? histogram(data) : null,
  };
}
