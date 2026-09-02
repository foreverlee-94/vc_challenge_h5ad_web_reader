// Sanity check that the *vendored* h5wasm files boot and read an .h5ad.
// Node uses MEMFS (not WORKERFS), so this validates parsing, not lazy IO.
//
//   node scripts/smoke_h5wasm.mjs context_A.h5ad

import { readFileSync } from "node:fs";
import { ready, File as H5File } from "../docs/vendor/h5wasm/hdf5_hl.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/smoke_h5wasm.mjs <file.h5ad>");
  process.exit(1);
}

const Module = await ready;
const FS = Module.FS;
FS.writeFile("in.h5ad", readFileSync(path));
const f = new H5File("in.h5ad", "r");

const j = (o) =>
  JSON.stringify(o, (_k, v) =>
    typeof v === "bigint" ? Number(v) : ArrayBuffer.isView(v) ? Array.from(v, (x) => (typeof x === "bigint" ? Number(x) : x)) : v
  );

console.log("root keys :", f.keys());
console.log("encoding  :", f.attrs["encoding-type"]?.value, f.attrs["encoding-version"]?.value);

const X = f.get("X");
console.log("X kind    :", typeof X.keys === "function" ? "group" : "dataset");
if (typeof X.keys === "function") {
  const shape = Array.from(X.attrs["shape"].value, Number);
  const indptr = f.get("X/indptr");
  const nnz = Number(indptr.slice([[shape[0], shape[0] + 1]])[0]);
  console.log("X shape   :", j(shape), " nnz:", nnz, " density:", (nnz / (shape[0] * shape[1])).toFixed(4));
  console.log("X/data[:6]:", j(f.get("X/data").slice([[0, 6]])));
}

for (const grpName of ["obs", "var"]) {
  const g = f.get(grpName);
  console.log(`${grpName} cols  :`, g.keys());
}

f.close();
console.log("OK");
