// Tiny dependency-free SVG charts. Colours come from CSS (.chart classes).
// Every chart takes { xLabel, yLabel } and always draws both axis captions.

function escXml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// X caption centred under the axis; Y caption sits horizontally at the very
// top-left (rotated CJK text is hard to read).
function axisLabels(width, height, plotL, plotR, plotT, xLabel, yLabel) {
  const xMid = plotL + (plotR - plotL) / 2;
  return (
    `<text x="${xMid.toFixed(1)}" y="${height - 5}" text-anchor="middle" class="axl">${escXml(xLabel || "")}</text>` +
    `<text x="2" y="11" class="axl">${escXml(yLabel || "")}</text>`
  );
}

// Vertical bar chart. items: [{ value, count }]
export function barChartSVG(items, { max = 24, width = 640, height = 320, xLabel = "값", yLabel = "개수" } = {}) {
  const rows = items.slice(0, max);
  if (!rows.length) return `<p class="muted">표시할 값이 없습니다.</p>`;
  let vmax = 1;
  for (const r of rows) if (r.count > vmax) vmax = r.count;

  const padL = 50,
    padR = 14,
    padT = 26,
    padB = 98;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const step = plotW / rows.length;
  const bw = Math.min(46, step * 0.68);
  const baseY = padT + plotH;

  const bars = rows
    .map((r, i) => {
      const bh = (plotH * r.count) / vmax;
      const cx = padL + i * step + step / 2;
      const x = cx - bw / 2;
      const y = baseY - bh;
      const ly = baseY + 12;
      return (
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" class="bar"/>` +
        `<text x="${cx.toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" class="num">${r.count.toLocaleString()}</text>` +
        `<text x="${cx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="end" class="lbl" transform="rotate(-40 ${cx.toFixed(1)} ${ly.toFixed(1)})">${escXml(
          trunc(r.value, 18),
        )}</text>`
      );
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" class="chart" preserveAspectRatio="xMinYMin meet" role="img" aria-label="막대그래프 (x: ${escXml(xLabel)}, y: ${escXml(yLabel)})">
    ${bars}
    <line x1="${padL}" y1="${baseY}" x2="${width - padR}" y2="${baseY}" class="axis"/>
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${baseY}" class="axis"/>
    <text x="${padL - 6}" y="${padT + 4}" text-anchor="end" class="num">${vmax.toLocaleString()}</text>
    <text x="${padL - 6}" y="${baseY}" text-anchor="end" class="num">0</text>
    ${axisLabels(width, height, padL, width - padR, padT, xLabel, yLabel)}
  </svg>`;
}

// hist: { edges:[...], counts:[...] }
export function histogramSVG(hist, { width = 620, height = 250, xLabel = "값", yLabel = "빈도" } = {}) {
  const { edges, counts } = hist;
  if (!counts || !counts.length) return `<p class="muted">표시할 데이터가 없습니다.</p>`;
  const padL = 48,
    padR = 14,
    padT = 26,
    padB = 46;
  let cmax = 1;
  for (const c of counts) if (c > cmax) cmax = c;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const baseY = padT + plotH;
  const bw = plotW / counts.length;
  const bars = counts
    .map((c, i) => {
      const bh = (plotH * c) / cmax;
      const x = padL + i * bw;
      const y = baseY - bh;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0.5, bw - 1).toFixed(1)}" height="${bh.toFixed(1)}" class="bar"/>`;
    })
    .join("");
  // plain integer / decimal (no exponential), grouped thousands
  const fmt = (v) => {
    if (!Number.isFinite(v)) return String(v);
    if (v === 0) return "0";
    const a = Math.abs(v);
    const digits = a >= 100 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
    return v.toLocaleString("en-US", { maximumFractionDigits: digits });
  };
  return `<svg viewBox="0 0 ${width} ${height}" class="chart" preserveAspectRatio="xMinYMin meet" role="img" aria-label="히스토그램 (x: ${escXml(xLabel)}, y: ${escXml(yLabel)})">
    ${bars}
    <line x1="${padL}" y1="${baseY}" x2="${width - padR}" y2="${baseY}" class="axis"/>
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${baseY}" class="axis"/>
    <text x="${padL}" y="${baseY + 14}" class="num">${fmt(edges[0])}</text>
    <text x="${width - padR}" y="${baseY + 14}" text-anchor="end" class="num">${fmt(edges[edges.length - 1])}</text>
    <text x="${padL - 6}" y="${padT + 4}" text-anchor="end" class="num">${cmax.toLocaleString()}</text>
    <text x="${padL - 6}" y="${baseY}" text-anchor="end" class="num">0</text>
    ${axisLabels(width, height, padL, width - padR, padT, xLabel, yLabel)}
  </svg>`;
}

function trunc(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
