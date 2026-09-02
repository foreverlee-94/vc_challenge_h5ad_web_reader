// Tiny dependency-free SVG charts. Colours come from CSS (.chart classes).

function escXml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// items: [{ value, count }]
export function barChartSVG(items, { max = 20, width = 560 } = {}) {
  const rows = items.slice(0, max);
  if (!rows.length) return `<p class="muted">표시할 값이 없습니다.</p>`;
  let vmax = 1;
  for (const r of rows) if (r.count > vmax) vmax = r.count;
  const bh = 18,
    gap = 6,
    labelW = 150,
    numW = 70,
    padY = 8;
  const h = padY * 2 + rows.length * (bh + gap);
  const trackW = width - labelW - numW;
  const bars = rows
    .map((r, i) => {
      const y = padY + i * (bh + gap);
      const w = Math.max(1, (trackW * r.count) / vmax);
      return (
        `<text x="${labelW - 8}" y="${y + bh * 0.72}" text-anchor="end" class="lbl">${escXml(trunc(r.value, 22))}</text>` +
        `<rect x="${labelW}" y="${y}" width="${w.toFixed(1)}" height="${bh}" rx="2" class="bar"/>` +
        `<text x="${labelW + w + 6}" y="${y + bh * 0.72}" class="num">${r.count.toLocaleString()}</text>`
      );
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${h}" class="chart" preserveAspectRatio="xMinYMin meet" role="img" aria-label="막대그래프">${bars}</svg>`;
}

// hist: { edges:[...], counts:[...] }
export function histogramSVG(hist, { width = 600, height = 220 } = {}) {
  const { edges, counts } = hist;
  if (!counts || !counts.length) return `<p class="muted">표시할 데이터가 없습니다.</p>`;
  const padL = 36,
    padR = 12,
    padT = 20,
    padB = 26;
  let cmax = 1;
  for (const c of counts) if (c > cmax) cmax = c;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const bw = plotW / counts.length;
  const bars = counts
    .map((c, i) => {
      const bh = (plotH * c) / cmax;
      const x = padL + i * bw;
      const y = padT + plotH - bh;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0.5, bw - 1).toFixed(1)}" height="${bh.toFixed(1)}" class="bar"/>`;
    })
    .join("");
  const fmt = (v) => (Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 0.01) ? v.toExponential(2) : Number(v.toFixed(3)));
  return `<svg viewBox="0 0 ${width} ${height}" class="chart" preserveAspectRatio="xMinYMin meet" role="img" aria-label="히스토그램">
    ${bars}
    <line x1="${padL}" y1="${padT + plotH}" x2="${width - padR}" y2="${padT + plotH}" class="axis"/>
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" class="axis"/>
    <text x="${padL}" y="${height - 8}" class="num">${fmt(edges[0])}</text>
    <text x="${width - padR}" y="${height - 8}" text-anchor="end" class="num">${fmt(edges[edges.length - 1])}</text>
    <text x="${padL - 6}" y="${padT + 4}" text-anchor="end" class="num">${cmax.toLocaleString()}</text>
    <text x="${padL - 6}" y="${padT + plotH}" text-anchor="end" class="num">0</text>
  </svg>`;
}

function trunc(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
