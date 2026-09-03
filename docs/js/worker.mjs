// Web Worker backend: HDF5 reading off the main thread, with the user's File
// mounted via WORKERFS (lazy slice reads, no full in-memory copy).
//
// The main thread falls back to mainengine.mjs if this worker fails to boot
// (older browsers / blocked module workers), so keep the op set + message
// contract in sync with app.mjs and mainengine.mjs.

import { ready, File as H5File } from "../vendor/h5wasm/hdf5_hl.js";
import { summarize, quickShape } from "./anndata.mjs";
import { buildReport } from "./hdf5tree.mjs";
import { readColumn, readUnsNode, matrixWithLabels, axisIndex, columnPage } from "./reads.mjs";

const MOUNT = "/work";
const SCAN_MOUNT = "/scan";
let Module = null;
let FS = null;
let current = null;

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
const step = (msg) => progressTarget != null && self.postMessage({ id: progressTarget, progress: msg });

async function open(file) {
  step("WASM 초기화 중…");
  await ensureReady();
  closeCurrent();
  step("파일 준비 중…");
  try {
    FS.mkdir(MOUNT);
  } catch (_) {}
  FS.mount(FS.filesystems.WORKERFS, { files: [file] }, MOUNT);
  const path = `${MOUNT}/${file.name}`;
  step("HDF5 열기…");
  const h5 = new H5File(path, "r");
  current = { h5, path };
  return buildReport(summarize, h5, file, step);
}

function need() {
  if (!current) throw new Error("먼저 파일을 여세요.");
  return current.h5;
}

// Mount one file at a throwaway point, read just its shape, unmount. Does not
// touch the currently-open file. WORKERFS => only a few KB is actually read.
async function scanFile(file) {
  await ensureReady();
  try {
    FS.mkdir(SCAN_MOUNT);
  } catch (_) {}
  let h5 = null;
  try {
    FS.mount(FS.filesystems.WORKERFS, { files: [file] }, SCAN_MOUNT);
    h5 = new H5File(`${SCAN_MOUNT}/${file.name}`, "r");
    return quickShape(h5);
  } finally {
    try {
      h5 && h5.close();
    } catch (_) {}
    try {
      FS.unmount(SCAN_MOUNT);
    } catch (_) {}
  }
}

const OPS = {
  open: (p) => open(p.file),
  column: (p) => readColumn(need(), p.axis, p.key),
  columnPage: (p) => columnPage(need(), p.axis, p.key, p.offset, p.count),
  matrix: (p) => matrixWithLabels(need(), p),
  unsNode: (p) => readUnsNode(need(), p.path),
  axisIndex: (p) => axisIndex(need(), p.axis),
  scanFile: (p) => scanFile(p.file),
};

self.onmessage = async (ev) => {
  const { id, type, payload } = ev.data || {};
  progressTarget = id;
  try {
    const fn = OPS[type];
    if (!fn) throw new Error(`unknown message type: ${type}`);
    self.postMessage({ id, ok: true, result: await fn(payload || {}) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.stack ? err.stack : String(err) });
  } finally {
    progressTarget = null;
  }
};

self.postMessage({ boot: true });
