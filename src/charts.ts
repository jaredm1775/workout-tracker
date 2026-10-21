// Small hand-built SVG charts for the Progress tab. Each mark carries a
// data-tip; app.ts shows one shared tooltip for whatever the pointer is over.

export interface ColumnDatum {
  label: string;
  value: number;
  tip: string;
}

export interface LinePoint {
  x: number;
  y: number;
  tip: string;
}

const WIDTH = 340;
const HEIGHT = 170;
const PAD = { top: 16, right: 12, bottom: 24, left: 40 };

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${+(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${+(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return `${+value.toFixed(1)}`;
}

// Three to five round ticks covering [min, max].
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (max <= min) max = min + 1;
  const raw = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= max + step * 0.001; value += step) ticks.push(+value.toFixed(6));
  if (ticks[ticks.length - 1] < max) ticks.push(+(ticks[ticks.length - 1] + step).toFixed(6));
  return ticks;
}

function frame(ticks: number[], y: (value: number) => number, unit = ""): string {
  return ticks
    .map(
      (tick) => `
      <line class="chart-grid" x1="${PAD.left}" x2="${WIDTH - PAD.right}" y1="${y(tick)}" y2="${y(tick)}" />
      <text class="chart-axis" x="${PAD.left - 6}" y="${y(tick) + 4}" text-anchor="end">${compact(tick)}${unit}</text>`,
    )
    .join("");
}

function svg(body: string, label: string): string {
  return `<svg class="chart" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeHtml(label)}">${body}</svg>`;
}

// Columns from a zero baseline, capped at 24px, square at the base and rounded
// at the top. An optional reference line marks a target.
export function columnChart(data: ColumnDatum[], label: string, reference?: number): string {
  const maxValue = Math.max(reference ?? 0, ...data.map((d) => d.value), 1);
  const ticks = niceTicks(0, maxValue, 3);
  const top = ticks[ticks.length - 1];
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const y = (value: number) => PAD.top + plotH - (value / top) * plotH;
  const band = (WIDTH - PAD.left - PAD.right) / data.length;
  const barW = Math.min(24, band - 4);
  const labelEvery = Math.ceil(data.length / 6);
  const peak = data.reduce((best, d, i) => (d.value > data[best].value ? i : best), 0);

  const bars = data
    .map((d, i) => {
      const cx = PAD.left + band * i + band / 2;
      const h = Math.max(0, y(0) - y(d.value));
      const r = Math.min(4, h, barW / 2);
      const x0 = cx - barW / 2;
      const x1 = cx + barW / 2;
      const yTop = y(d.value);
      const path = h
        ? `M${x0},${y(0)} V${yTop + r} Q${x0},${yTop} ${x0 + r},${yTop} H${x1 - r} Q${x1},${yTop} ${x1},${yTop + r} V${y(0)} Z`
        : "";
      const isLast = i === data.length - 1;
      const showValue = d.value > 0 && (isLast || i === peak);
      return `
        <g class="chart-hit" data-tip="${escapeHtml(d.tip)}" tabindex="0">
          <rect x="${PAD.left + band * i}" y="${PAD.top}" width="${band}" height="${plotH}" fill="transparent" />
          ${path ? `<path class="chart-bar${isLast ? " current" : ""}" d="${path}" />` : ""}
          ${showValue ? `<text class="chart-value" x="${cx}" y="${yTop - 5}" text-anchor="middle">${compact(d.value)}</text>` : ""}
        </g>
        ${(data.length - 1 - i) % labelEvery === 0 ? `<text class="chart-axis" x="${cx}" y="${HEIGHT - 6}" text-anchor="middle">${escapeHtml(d.label)}</text>` : ""}`;
    })
    .join("");

  const ref =
    reference != null
      ? `<line class="chart-ref" x1="${PAD.left}" x2="${WIDTH - PAD.right}" y1="${y(reference)}" y2="${y(reference)}" />`
      : "";
  return svg(frame(ticks, y) + ref + bars, label);
}

// A single 2px line with dots and a column-shaped hit area per point, so the
// pointer only has to be near a session's date.
export function lineChart(points: LinePoint[], label: string, xLabel: (x: number) => string, unit = ""): string {
  if (!points.length) return "";
  const ys = points.map((p) => p.y);
  const spread = Math.max(...ys) - Math.min(...ys);
  const ticks = niceTicks(Math.max(0, Math.min(...ys) - spread * 0.15 - 1), Math.max(...ys) + spread * 0.1 + 1, 4);
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const plotW = WIDTH - PAD.left - PAD.right;
  const y = (value: number) => PAD.top + plotH - ((value - lo) / (hi - lo)) * plotH;
  const minX = points[0].x;
  const maxX = points[points.length - 1].x;
  const x = (value: number) =>
    maxX === minX ? PAD.left + plotW / 2 : PAD.left + ((value - minX) / (maxX - minX)) * plotW;

  const path = points.map((p, i) => `${i ? "L" : "M"}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(" ");
  const area = `${path} L${x(maxX).toFixed(1)},${y(lo)} L${x(minX).toFixed(1)},${y(lo)} Z`;
  // The latest of any tied highs, so a best that equals the last point is labelled once.
  const bestIndex = points.reduce((best, p, i) => (p.y >= points[best].y ? i : best), 0);
  const lastIndex = points.length - 1;
  // With many sessions only the labelled dots stay; the rest appear on hover.
  const dense = points.length > 14;

  const hits = points
    .map((p, i) => {
      const left = i === 0 ? PAD.left : (x(points[i - 1].x) + x(p.x)) / 2;
      const right = i === lastIndex ? WIDTH - PAD.right : (x(p.x) + x(points[i + 1].x)) / 2;
      const labelled = i === lastIndex || i === bestIndex;
      return `
        <g class="chart-hit" data-tip="${escapeHtml(p.tip)}" tabindex="0">
          <rect x="${left}" y="${PAD.top}" width="${Math.max(right - left, 1)}" height="${plotH}" fill="transparent" />
          <line class="chart-cross" x1="${x(p.x)}" x2="${x(p.x)}" y1="${PAD.top}" y2="${PAD.top + plotH}" />
          <circle class="chart-dot${dense && !labelled ? " minor" : ""}" cx="${x(p.x)}" cy="${y(p.y)}" r="${labelled ? 4.5 : 3.5}" />
          ${
            labelled
              ? `<text class="chart-value" x="${Math.min(x(p.x), WIDTH - PAD.right - 4)}" y="${y(p.y) - 9}" text-anchor="${i === lastIndex ? "end" : "middle"}">${compact(p.y)}${unit}</text>`
              : ""
          }
        </g>`;
    })
    .join("");

  const xAxis =
    maxX === minX
      ? `<text class="chart-axis" x="${x(minX)}" y="${HEIGHT - 6}" text-anchor="middle">${escapeHtml(xLabel(minX))}</text>`
      : `<text class="chart-axis" x="${PAD.left}" y="${HEIGHT - 6}" text-anchor="start">${escapeHtml(xLabel(minX))}</text>
         <text class="chart-axis" x="${WIDTH - PAD.right}" y="${HEIGHT - 6}" text-anchor="end">${escapeHtml(xLabel(maxX))}</text>`;

  return svg(
    `${frame(ticks, y)}<path class="chart-area" d="${area}" /><path class="chart-line" d="${path}" />${hits}${xAxis}`,
    label,
  );
}
