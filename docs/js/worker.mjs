// Web Worker: all HDF5 / h5ad reading happens here so the UI never blocks.
//
// Phase 0: mount a user File via WORKERFS (lazy, no full copy) and walk the
// raw HDF5 tree. The AnnData semantic layer (density, categorical decode,
// column stats, matrix slices) is added in later phases via anndata.mjs.

import { ready, File as H5File } from "../vendor/h5wasm/hdf5_hl.js";
import { summarize } from "./anndata.mjs";

const MOUNT = "/work";
let Module = null;
let FS = null;
let current = null; // { h5: H5File, path: string }

// ---- helpers ---------------------------------------------------------------

// h5wasm returns int64 attrs/shapes as BigInt; typed arrays for vector data.
// Make everything structured-clone friendly and JSON-sane.
function normalize(value, cap = 64) {
  if (typeof value === "bigint") return Number(value);
  if (ArrayBuffer.isView(value)) {
    const arr = Array.from(value, (v) => (typeof v === "bigint" ? Number(v) : v));
    return arr.length > cap ? { preview: arr.slice(0, cap), length: arr.length } : arr;
  }
  if (Array.isArray(value)) {
    const arr = value.map((v) => (typeof v === "bigint" ? Number(v) : v));
    return arr.length > cap ? { preview: arr.slice(0, cap), length: arr.length } : arr;
  }
  return value;
}

function readAttrs(node) {
  const out = {};
  const raw = node.attrs || {};
  for (const name of Object.keys(raw)) {
    try {
      out[name] = normalize(raw[name].value);
    } catch (err) {
      out[name] = `<unreadable: ${err.message}>`;
    }
  }
  return out;
}

function isGroup(node) {
  return node && typeof node.keys === "function";
}

// Recursively describe the tree. Guard against pathological `uns` depth/size.
function describe(node, name, depth, opts) {
  const entry = { name, attrs: readAttrs(node) };
  if (isGroup(node)) {
    entry.kind = "group";
    entry.children = [];
    if (depth >= opts.maxDepth) {
      entry.truncated = "max-depth";
      return entry;
    }
    let keys;
    try {
      keys = node.keys();
    } catch (err) {
      entry.error = err.message;
      return entry;
    }
    entry.childCount = keys.length;
    const limit = Math.min(keys.length, opts.maxChildren);
    for (let i = 0; i < limit; i++) {
      const key = keys[i];
      let child;
      try {
        child = node.get(key);
      } catch (err) {
        entry.children.push({ name: key, kind: "error", error: err.message });
        continue;
      }
      entry.children.push(describe(child, key, depth + 1, opts));
    }
    if (keys.length > limit) entry.truncated = `${keys.length - limit} more`;
  } else {
    // Dataset (or Datatype / link). Never read `.value` here — could be GBs.
    entry.kind = "dataset";
    try {
      entry.shape = normalize(node.shape);
      entry.dtype = node.dtype;
      entry.metadata = node.metadata || null;
    } catch (err) {
      entry.error = err.message;
    }
  }
  return entry;
}

// ---- lifecycle -----------------------------------------------------------

async function ensureReady() {
  if (Module) return;
  Module = await ready;
  FS = Module.FS;
}

function closeCurrent() {
  if (current) {
    try {
      current.h5.close();
    } catch (_) {}
    current = null;
  }
  try {
    FS.unmount(MOUNT);
  } catch (_) {}
}

let progressTarget = null;
const step = (msg) => progressTarget && self.postMessage({ id: progressTarget, progress: msg });

async function open(file) {
  step("WASM 초기화 중…");
  await ensureReady();
  closeCurrent();
  step("파일 마운트 중…");
  try {
    FS.mkdir(MOUNT);
  } catch (_) {
    // already exists
  }
  // WORKERFS reads lazily from the Blob via FileReaderSync — no full copy.
  FS.mount(FS.filesystems.WORKERFS, { files: [file] }, MOUNT);
  const path = `${MOUNT}/${file.name}`;
  step("HDF5 열기…");
  const h5 = new H5File(path, "r");
  current = { h5, path };

  step("구조 분석 중…");
  const summary = summarize(h5);
  step("트리 생성 중…");
  const tree = describe(h5, file.name, 0, { maxDepth: 8, maxChildren: 500 });

  return {
    file: { name: file.name, size: file.size },
    summary,
    tree,
  };
}

// ---- message plumbing --------------------------------------------------

self.onmessage = async (ev) => {
  const { id, type, payload } = ev.data || {};
  progressTarget = id;
  try {
    let result;
    switch (type) {
      case "open":
        result = await open(payload.file);
        break;
      default:
        throw new Error(`unknown message type: ${type}`);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.stack ? err.stack : String(err) });
  } finally {
    progressTarget = null;
  }
};

self.postMessage({ id: null, ok: true, result: { ready: "booting" } });
