// Main-thread fallback: same ops as worker.mjs but running h5wasm on the UI
// thread with the file loaded into MEMFS (whole file in memory). Used when the
// module worker can't boot. Reads block the UI briefly; large files need
// roughly file-size memory.

import { ready, File as H5File } from "../vendor/h5wasm/hdf5_hl.js";
import { summarize } from "./anndata.mjs";
import { buildReport } from "./hdf5tree.mjs";
import { readColumn, readUnsNode, matrixWithLabels } from "./reads.mjs";

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

export const mainEngine = {
  mode: "main",
  call(type, payload = {}, onProgress = () => {}) {
    switch (type) {
      case "open":
        return open(payload.file, onProgress);
      case "column":
        return Promise.resolve().then(() => readColumn(need(), payload.axis, payload.key));
      case "matrix":
        return Promise.resolve().then(() => matrixWithLabels(need(), payload));
      case "unsNode":
        return Promise.resolve().then(() => readUnsNode(need(), payload.path));
      default:
        return Promise.reject(new Error(`unknown op: ${type}`));
    }
  },
};
