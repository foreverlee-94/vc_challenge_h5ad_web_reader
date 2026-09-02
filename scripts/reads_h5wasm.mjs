// Exercise the read ops (docs/js/reads.mjs) under Node against a file.
//   node scripts/reads_h5wasm.mjs scratchpad/fixture.h5ad

import { readFileSync } from "node:fs";
import { ready, File as H5 } from "../docs/vendor/h5wasm/hdf5_hl.js";
import { readColumn, readMatrixSlice, matrixWithLabels, readUnsNode } from "../docs/js/reads.mjs";
import { summarize } from "../docs/js/anndata.mjs";

const path = process.argv[2] || "scratchpad/fixture.h5ad";
const M = await ready;
M.FS.writeFile("in.h5ad", readFileSync(path));
const f = new H5("in.h5ad", "r");

const s = summarize(f);
console.log(`# ${path}  (${s.n_obs} x ${s.n_vars})`);

// every obs column + index
for (const key of ["__index__", ...s.obs.columns.map((c) => c.name)]) {
  const d = readColumn(f, "obs", key);
  const bits = [`kind=${d.kind}`, `n=${d.n}`];
  if (d.stats) bits.push(`min=${round(d.stats.min)} max=${round(d.stats.max)} mean=${round(d.stats.mean)}`);
  if (d.items) bits.push(`top=${d.items.slice(0, 3).map((x) => x.value + ":" + x.count).join(",")}`);
  if (d.nUnique != null) bits.push(`uniq=${d.nUnique}`);
  if (d.nMissing) bits.push(`missing=${d.nMissing}`);
  console.log(`obs/${key.padEnd(16)} ${bits.join("  ")}`);
}

// X slice
const sl = matrixWithLabels(f, { path: "X", r0: 0, rn: 4, c0: 0, cn: 6, rowAxis: "obs", colAxis: "var" });
console.log(`\nX[0:4, 0:6] format=${sl.format} rows=${JSON.stringify(sl.rows)}`);
console.log(`  rowLabels=${JSON.stringify(sl.rowLabels)}`);
console.log(`  colLabels=${JSON.stringify(sl.colLabels)}`);

// a dense layer slice (if present)
if (s.layers && s.layers.dense_log1p) {
  const dl = readMatrixSlice(f, "layers/dense_log1p", 0, 3, 0, 4);
  console.log(`\nlayers/dense_log1p[0:3,0:4] format=${dl.format}`, JSON.stringify(dl.rows.map((r) => r.map(round))));
}

// obsm
if (s.obsm && s.obsm.X_pca) {
  const pca = matrixWithLabels(f, { path: "obsm/X_pca", r0: 0, rn: 3, c0: 0, cn: 5, rowAxis: "obs", colAxis: null });
  console.log(`\nobsm/X_pca[0:3,0:5]`, JSON.stringify(pca.rows.map((r) => r.map(round))), "rowLabels", JSON.stringify(pca.rowLabels));
}

// uns leaves
for (const p of ["uns/title", "uns/n_neighbors", "uns/params/method", "uns/params/alpha", "uns/color_map", "uns/params"]) {
  try {
    const d = readUnsNode(f, p);
    console.log(`${p.padEnd(22)} ${JSON.stringify(d).slice(0, 160)}`);
  } catch (e) {
    console.log(`${p.padEnd(22)} ERR ${e.message}`);
  }
}

f.close();
console.log("\nOK");

function round(v) {
  return typeof v === "number" ? Math.round(v * 1000) / 1000 : v;
}
