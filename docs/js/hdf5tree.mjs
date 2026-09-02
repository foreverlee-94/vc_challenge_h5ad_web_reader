// Raw HDF5 tree description — shared by the worker and the main-thread engine.
// Pure functions over h5wasm node objects.

export function isGroup(node) {
  return !!node && typeof node.keys === "function";
}

// h5wasm returns int64 as BigInt and vectors as typed arrays. Make everything
// structured-clone / JSON friendly; cap long arrays.
export function normalize(value, cap = 64) {
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

export function readAttrs(node) {
  const out = {};
  const raw = node.attrs || {};
  for (const name of Object.keys(raw)) {
    try {
      const a = raw[name];
      out[name] = normalize(a && typeof a === "object" && "value" in a ? a.value : a);
    } catch (err) {
      out[name] = `<unreadable: ${err.message}>`;
    }
  }
  return out;
}

// Recursively describe the tree. Guards against pathological uns depth/size.
export function describe(node, name, depth, opts) {
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

// Build the { file, summary, tree } payload from an open h5wasm File.
export function buildReport(summarize, h5, file, step = () => {}) {
  step("구조 분석 중…");
  const summary = summarize(h5);
  step("트리 생성 중…");
  const tree = describe(h5, file.name, 0, { maxDepth: 8, maxChildren: 500 });
  return { file: { name: file.name, size: file.size }, summary, tree };
}
