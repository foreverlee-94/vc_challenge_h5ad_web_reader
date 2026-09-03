// AnnData-on-HDF5 semantic layer.
//
// Turns an h5wasm `File` into a structural summary using the AnnData encoding
// conventions (the `encoding-type` attribute on each group/dataset). Pure
// functions operating on h5wasm objects, so this also runs under Node for tests
// (see scripts/summary_h5wasm.mjs).
//
// Rule: the summary only does *tiny* reads (attributes, shapes, dtypes, the last
// element of indptr). No column values, no matrix data — those come from the
// per-item ops in later phases.

const MAPPINGS = ["layers", "obsm", "varm", "obsp", "varp"];

// ---- low-level helpers ---------------------------------------------------

export function isGroup(node) {
  return !!node && typeof node.keys === "function";
}

// h5wasm returns int64 as BigInt, array attrs sometimes as a plain object with
// "0","1",... keys, and typed arrays for vectors. Flatten all of that.
export function normAttr(v) {
  if (typeof v === "bigint") return Number(v);
  if (ArrayBuffer.isView(v)) return Array.from(v, (x) => (typeof x === "bigint" ? Number(x) : x));
  if (Array.isArray(v)) return v.map((x) => (typeof x === "bigint" ? Number(x) : x));
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length && keys.every((k, i) => k === String(i))) return keys.map((k) => normAttr(v[k]));
  }
  return v;
}

export function attr(node, name) {
  try {
    const a = node.attrs && node.attrs[name];
    if (a === undefined) return undefined;
    return normAttr(a && typeof a === "object" && "value" in a ? a.value : a);
  } catch (_) {
    return undefined;
  }
}

export function encodingOf(node) {
  const e = attr(node, "encoding-type");
  return typeof e === "string" ? e : null;
}

export function child(grp, name) {
  try {
    return grp.keys().includes(name) ? grp.get(name) : null;
  } catch (_) {
    return null;
  }
}

// Friendly dtype + coarse class from h5wasm dataset .metadata.
// metadata.type: 0=int, 1=float, 3=string, 8=enum(bool = FALSE/TRUE members).
export function typeInfo(meta) {
  if (!meta) return { dtype: "unknown", cls: "other" };
  const { type, size, signed, enum_type } = meta;
  if (type === 1) return { dtype: `float${size * 8}`, cls: "numeric" };
  if (type === 0) return { dtype: `${signed ? "int" : "uint"}${size * 8}`, cls: "numeric" };
  if (type === 3) return { dtype: "string", cls: "string" };
  if (type === 8) {
    const m = enum_type && enum_type.members;
    if (m && "FALSE" in m && "TRUE" in m && Object.keys(m).length === 2) return { dtype: "bool", cls: "bool" };
    return { dtype: "enum", cls: "numeric" };
  }
  if (type === 6) return { dtype: "compound", cls: "other" };
  return { dtype: "other", cls: "other" };
}

function datasetShape(ds) {
  return normAttr(ds.shape);
}

// ---- matrices ----------------------------------------------------------

export function summarizeMatrix(node) {
  if (!node) return null;
  if (isGroup(node)) {
    const enc = encodingOf(node);
    const format = enc === "csc_matrix" ? "csc" : "csr";
    const shape = normAttr(attr(node, "shape")) || [null, null];
    const dataDs = child(node, "data");
    const indptrDs = child(node, "indptr");
    let nnz = null;
    if (indptrDs) {
      try {
        const L = normAttr(indptrDs.shape)[0];
        const last = indptrDs.slice([[L - 1, L]]);
        nnz = Number(last[0]);
      } catch (_) {}
    }
    const rows = shape[0],
      cols = shape[1];
    const density = nnz != null && rows && cols ? nnz / (rows * cols) : null;
    return {
      format,
      encoding: enc,
      shape,
      dtype: dataDs ? typeInfo(dataDs.metadata).dtype : null,
      nnz,
      density,
    };
  }
  // dense
  const ti = typeInfo(node.metadata);
  return { format: "dense", encoding: attr(node, "encoding-type") || "array", shape: datasetShape(node), dtype: ti.dtype, nnz: null, density: null };
}

// ---- dataframes ------------------------------------------------------

function indexInfo(grp, indexName) {
  const node = child(grp, indexName);
  if (!node) return { kind: "string", nRows: null };
  if (isGroup(node)) {
    const vals = child(node, "values");
    return {
      kind: "string",
      encoding: encodingOf(node),
      nullable: !!child(node, "mask"),
      nRows: vals ? normAttr(vals.shape)[0] : null,
    };
  }
  const ti = typeInfo(node.metadata);
  return { kind: ti.cls, dtype: ti.dtype, nRows: normAttr(node.shape)[0] };
}

function columnInfo(grp, name) {
  const node = child(grp, name);
  if (!node) return { name, kind: "missing" };
  if (isGroup(node)) {
    const enc = encodingOf(node);
    if (enc === "categorical") {
      const cats = child(node, "categories");
      return {
        name,
        encoding: enc,
        kind: "categorical",
        dtype: "category",
        nCategories: cats ? normAttr(cats.shape)[0] : null,
        ordered: !!attr(node, "ordered"),
      };
    }
    if (enc === "nullable-integer" || enc === "nullable-boolean") {
      const vals = child(node, "values");
      const ti = vals ? typeInfo(vals.metadata) : { dtype: "?", cls: "numeric" };
      return { name, encoding: enc, kind: enc === "nullable-boolean" ? "bool" : "numeric", dtype: ti.dtype, nullable: true };
    }
    if (enc === "nullable-string-array" || enc === "string-array") {
      return { name, encoding: enc, kind: "string", dtype: "string", nullable: !!child(node, "mask") };
    }
    return { name, encoding: enc || "group", kind: "group", keys: safeKeys(node) };
  }
  const ti = typeInfo(node.metadata);
  return { name, encoding: attr(node, "encoding-type") || null, kind: ti.cls, dtype: ti.dtype };
}

function safeKeys(grp) {
  try {
    return grp.keys();
  } catch (_) {
    return [];
  }
}

export function summarizeDataframe(grp) {
  if (!grp) return null;
  const indexName = attr(grp, "_index") || "_index";
  const order = normAttr(attr(grp, "column-order")) || [];
  const present = safeKeys(grp);
  const extras = present.filter((k) => k !== indexName && !order.includes(k));
  const colNames = [...order.filter((k) => present.includes(k)), ...extras];

  const idx = indexInfo(grp, indexName);
  const columns = colNames.map((n) => columnInfo(grp, n));

  let nRows = idx.nRows;
  if (nRows == null) {
    for (const c of columns) {
      const node = child(grp, c.name);
      if (!node) continue;
      const codes = isGroup(node) ? child(node, "codes") || child(node, "values") : node;
      if (codes) {
        nRows = normAttr(codes.shape)[0];
        break;
      }
    }
  }

  return {
    encoding: encodingOf(grp),
    indexName,
    index: idx,
    nRows,
    nColumns: columns.length,
    columns,
  };
}

// ---- mappings (layers / obsm / ...) --------------------------------

export function summarizeMapping(grp) {
  const out = {};
  if (!grp) return out;
  for (const key of safeKeys(grp)) {
    const node = child(grp, key);
    if (!node) continue;
    if (isGroup(node)) {
      const enc = encodingOf(node);
      if (enc === "csr_matrix" || enc === "csc_matrix") out[key] = summarizeMatrix(node);
      else out[key] = { format: "group", encoding: enc || "group", keys: safeKeys(node) };
    } else {
      const ti = typeInfo(node.metadata);
      out[key] = { format: "dense", shape: normAttr(node.shape), dtype: ti.dtype };
    }
  }
  return out;
}

// ---- uns -------------------------------------------------------------

export function summarizeUns(grp, depth = 0, maxDepth = 6, maxChildren = 200) {
  const out = {};
  if (!grp || !isGroup(grp)) return out;
  const keys = safeKeys(grp);
  const limit = Math.min(keys.length, maxChildren);
  for (let i = 0; i < limit; i++) {
    const key = keys[i];
    const node = child(grp, key);
    if (!node) continue;
    if (isGroup(node)) {
      out[key] =
        depth + 1 >= maxDepth
          ? { kind: "dict", truncated: true, keys: safeKeys(node) }
          : { kind: "dict", encoding: encodingOf(node), children: summarizeUns(node, depth + 1, maxDepth, maxChildren) };
    } else {
      const shape = normAttr(node.shape);
      const ti = typeInfo(node.metadata);
      if (Array.isArray(shape) && shape.length === 0) {
        let value;
        try {
          value = normAttr(node.value);
          if (typeof value === "string" && value.length > 200) value = value.slice(0, 200) + "…";
        } catch (_) {}
        out[key] = { kind: "scalar", dtype: ti.dtype, value };
      } else {
        out[key] = { kind: "array", shape, dtype: ti.dtype };
      }
    }
  }
  if (keys.length > limit) out.__truncated__ = `${keys.length - limit} more`;
  return out;
}

// ---- top level ------------------------------------------------------

export function summarize(file) {
  const encoding = attr(file, "encoding-type") || null;
  const encodingVersion = attr(file, "encoding-version") || null;
  const has = (k) => safeKeys(file).includes(k);

  const X = has("X") ? summarizeMatrix(file.get("X")) : null;
  const obs = has("obs") ? summarizeDataframe(file.get("obs")) : null;
  const varDf = has("var") ? summarizeDataframe(file.get("var")) : null;

  const out = {
    encoding,
    encodingVersion,
    X,
    obs,
    var: varDf,
  };

  for (const m of MAPPINGS) {
    out[m] = has(m) && isGroup(file.get(m)) ? summarizeMapping(file.get(m)) : {};
  }

  out.uns = has("uns") && isGroup(file.get("uns")) ? summarizeUns(file.get("uns")) : {};

  if (has("raw") && isGroup(file.get("raw"))) {
    const raw = file.get("raw");
    out.raw = {
      X: child(raw, "X") ? summarizeMatrix(child(raw, "X")) : null,
      var: child(raw, "var") ? summarizeDataframe(child(raw, "var")) : null,
    };
  } else {
    out.raw = null;
  }

  out.n_obs = X ? X.shape[0] : obs ? obs.nRows : null;
  out.n_vars = X ? X.shape[1] : varDf ? varDf.nRows : null;

  return out;
}

// Minimal read: just cell/gene counts + X format. A few KB of IO per file —
// used by the folder scan so RAM stays flat over hundreds of files.
export function quickShape(file) {
  const has = (k) => safeKeys(file).includes(k);
  let nObs = null;
  let nVars = null;
  let xFormat = null;

  if (has("X")) {
    const X = file.get("X");
    if (isGroup(X)) {
      const sh = normAttr(attr(X, "shape"));
      if (Array.isArray(sh)) [nObs, nVars] = sh;
      xFormat = encodingOf(X) === "csc_matrix" ? "csc" : "csr";
    } else {
      const sh = normAttr(X.shape) || [];
      nObs = sh[0] ?? null;
      nVars = sh.length > 1 ? sh[1] : sh.length === 1 ? 1 : null;
      xFormat = "dense";
    }
  }

  const indexDs = (axis) => {
    if (!has(axis)) return null;
    const g = file.get(axis);
    const idxName = attr(g, "_index") || "_index";
    const node = child(g, idxName);
    return node && isGroup(node) ? child(node, "values") : node;
  };
  const axisLen = (axis) => {
    try {
      const ds = indexDs(axis);
      return ds ? normAttr(ds.shape)[0] : null;
    } catch (_) {
      return null;
    }
  };
  if (nVars == null) nVars = axisLen("var");
  if (nObs == null) nObs = axisLen("obs");

  // distinct gene identifiers: a well-formed h5ad has var index == unique, but
  // concatenated / symbol-indexed files can carry duplicates. The index is a
  // few hundred KB even for a huge file, so this stays a light read.
  let nVarUnique = null;
  try {
    const ds = indexDs("var");
    const n = ds ? normAttr(ds.shape)[0] : null;
    if (n != null && n <= 5000000) {
      const seen = new Set();
      const vals = ds.value;
      for (let i = 0; i < vals.length; i++) seen.add(vals[i]);
      nVarUnique = seen.size;
    }
  } catch (_) {}

  // protein-coding subset (var.feature_type == "protein_coding"), if present
  let nProteinCoding = null;
  try {
    if (has("var")) {
      const ft = child(file.get("var"), "feature_type");
      if (ft && isGroup(ft) && encodingOf(ft) === "categorical") {
        const cats = Array.from(child(ft, "categories").value, String);
        const pc = cats.indexOf("protein_coding");
        if (pc >= 0) {
          const codes = child(ft, "codes").value;
          let n = 0;
          for (let i = 0; i < codes.length; i++) if (codes[i] === pc) n++;
          nProteinCoding = n;
        }
      }
    }
  } catch (_) {}

  // obs column carrying a per-cell gene/feature count, if any (name only)
  let obsGeneCol = null;
  try {
    if (has("obs")) {
      const cols = normAttr(attr(file.get("obs"), "column-order")) || [];
      obsGeneCol = cols.map(String).find((c) => OBS_GENE_RE.test(c)) || null;
    }
  } catch (_) {}

  return { nObs, nVars, nVarUnique, nProteinCoding, obsGeneCol, xFormat, encoding: attr(file, "encoding-type") || null };
}

export const OBS_GENE_RE =
  /^(n_?genes?(_by_counts)?|num_?genes?|gene_?counts?|count_?genes?|genes?_?count|n_?features?(_[a-z0-9]+)?|nfeatures?_?[a-z0-9]*|ngenes?|detected_?genes?|genes?_?detected|expressed_?genes?)$/i;
