// Main-thread fallback: same ops as worker.mjs but running h5wasm on the UI
// thread with the file loaded into MEMFS (whole file in memory). Used when the
// module worker can't boot. Reads block the UI briefly; large files need
// roughly file-size memory.

import { ready, File as H5File } from "../vendor/h5wasm/hdf5_hl.js";
import { summarize, quickShape } from "./anndata.mjs";
import { buildReport } from "./hdf5tree.mjs";
import { readColumn, readUnsNode, matrixWithLabels, axisIndex, columnPage } from "./reads.mjs";

let Module = null;
let FS = null;
let current = null;
let counter = 0;

async function open(file, onProgress = () => {}) {
  onProgress("WASM 초기화 중…");
  if (!Module) {
    Module = await ready;
    FS = Module.FS;
  }
  if (current) {
    try {
      current.h5.close();
    } catch (_) {}
    try {
      FS.unlink(current.path);
    } catch (_) {}
    current = null;
  }
  onProgress("파일 읽는 중… (메모리 로드)");
  const buf = new Uint8Array(await file.arrayBuffer());
  const path = `/mem_${++counter}.h5ad`;
  FS.writeFile(path, buf);
  onProgress("HDF5 열기…");
  const h5 = new H5File(path, "r");
  current = { h5, path };
  return buildReport(summarize, h5, file, onProgress);
}

function need() {
  if (!current) throw new Error("먼저 파일을 여세요.");
  return current.h5;
}

// One file at a time into MEMFS, read shape, free it. Peak RAM ~ one file.
async function scanFile(file) {
  if (!Module) {
    Module = await ready;
    FS = Module.FS;
  }
  const path = `/scan_${++counter}.h5ad`;
  FS.writeFile(path, new Uint8Array(await file.arrayBuffer()));
  try {
    const h5 = new H5File(path, "r");
    const r = quickShape(h5);
    h5.close();
    return r;
  } finally {
    try {
      FS.unlink(path);
    } catch (_) {}
  }
}

export const mainEngine = {
  mode: "main",
  call(type, payload = {}, onProgress = () => {}) {
    switch (type) {
      case "open":
        return open(payload.file, onProgress);
      case "column":
        return Promise.resolve().then(() => readColumn(need(), payload.axis, payload.key));
      case "columnPage":
        return Promise.resolve().then(() => columnPage(need(), payload.axis, payload.key, payload.offset, payload.count));
      case "matrix":
        return Promise.resolve().then(() => matrixWithLabels(need(), payload));
      case "unsNode":
        return Promise.resolve().then(() => readUnsNode(need(), payload.path));
      case "axisIndex":
        return Promise.resolve().then(() => axisIndex(need(), payload.axis));
      case "scanFile":
        return scanFile(payload.file);
      default:
        return Promise.reject(new Error(`unknown op: ${type}`));
    }
  },
};
