// Main-thread fallback: same result as worker.mjs but running h5wasm on the UI
// thread with the file loaded into MEMFS (whole file in memory). Used when the
// module worker can't boot. Reads block the UI briefly; for large files this
// needs roughly file-size memory.

import { ready, File as H5File } from "../vendor/h5wasm/hdf5_hl.js";
import { summarize } from "./anndata.mjs";
import { buildReport } from "./hdf5tree.mjs";

let Module = null;
let FS = null;
let current = null;
let counter = 0;

export async function openFileMain(file, onProgress = () => {}) {
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
