// Web Worker backend: HDF5 reading off the main thread, with the user's File
// mounted via WORKERFS (lazy slice reads, no full in-memory copy).
//
// The main thread falls back to mainengine.mjs if this worker fails to boot
// (older browsers / blocked module workers), so keep the message contract in
// sync with app.mjs.

import { ready, File as H5File } from "../vendor/h5wasm/hdf5_hl.js";
import { summarize } from "./anndata.mjs";
import { buildReport } from "./hdf5tree.mjs";

const MOUNT = "/work";
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

self.postMessage({ boot: true });
