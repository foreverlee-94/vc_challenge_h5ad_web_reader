// Pure statistics helpers for the inspect views. No h5wasm here.

export function minMax(a) {
  let mn = Infinity,
    mx = -Infinity;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  return [mn, mx];
}

// Keep only finite numbers.
function finite(values) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const v = +values[i];
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

export function numericStats(values) {
  const a = finite(values);
  a.sort((x, y) => x - y);
  const n = a.length;
  if (!n) return { n: 0 };
  const q = (p) => {
    const idx = (n - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return a[lo] + (a[hi] - a[lo]) * (idx - lo);
  };
  let sum = 0;
  for (const v of a) sum += v;
  const mean = sum / n;
  let ss = 0;
  for (const v of a) ss += (v - mean) ** 2;
  let nZero = 0;
  for (const v of a) if (v === 0) nZero++;
  return {
    n,
    min: a[0],
    max: a[n - 1],
    mean,
    std: Math.sqrt(ss / n),
    q1: q(0.25),
    median: q(0.5),
    q3: q(0.75),
    nZero,
  };
}

export function histogram(values, bins = 30) {
  const a = finite(values);
  if (!a.length) return { edges: [], counts: [] };
  let [min, max] = minMax(a);
  if (min === max) {
    // degenerate: single spike
    return { edges: [min - 0.5, max + 0.5], counts: [a.length], single: min };
  }
  const width = (max - min) / bins;
  const counts = new Array(bins).fill(0);
  for (const v of a) {
    let b = Math.floor((v - min) / width);
    if (b < 0) b = 0;
    if (b >= bins) b = bins - 1;
    counts[b]++;
  }
  const edges = Array.from({ length: bins + 1 }, (_, i) => min + i * width);
  return { edges, counts };
}

export function valueCounts(labels, top = 50) {
  const m = new Map();
  for (const v of labels) {
    const k = v === null || v === undefined ? "(결측)" : v;
    m.set(k, (m.get(k) || 0) + 1);
  }
  const all = [...m.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
  return { items: all.slice(0, top), nUnique: all.length, more: Math.max(0, all.length - top), total: labels.length };
}
