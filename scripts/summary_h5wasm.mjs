// Run the browser-side AnnData parser (docs/js/anndata.mjs) under Node and print
// its summary as JSON, to diff against scripts/expected_summary.py.
//
//   node scripts/summary_h5wasm.mjs context_A.h5ad
//   diff <(node scripts/summary_h5wasm.mjs context_A.h5ad) \
//        <(uv run python scripts/expected_summary.py context_A.h5ad)   # structural, not line-exact

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { ready, File as H5 } from "../docs/vendor/h5wasm/hdf5_hl.js";
import { summarize } from "../docs/js/anndata.mjs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/summary_h5wasm.mjs <file.h5ad>");
  process.exit(1);
}

const M = await ready;
M.FS.writeFile("in.h5ad", readFileSync(path));
const f = new H5("in.h5ad", "r");

const s = summarize(f);
s.file = { name: basename(path), size: statSync(path).size };

f.close();
console.log(JSON.stringify(s, null, 2));
