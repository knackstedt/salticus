// ============================================================================
// wb/svg.ts — serialize a whiteboard to SVG markup.
//
// Clean-stroke export: sketch jitter is a runtime style; the exported vector
// is precise geometry with the same colors, fills, arrowheads and text.
// ============================================================================

import type { Rgba } from "../text/gpu-text";
import type { WbContent, WbItem } from "./model";
import { wbFontSize } from "./model";
import {
  frameOf, frameCenter, resolvedPoints, textFrame, rot,
  type Frame, type MeasureFn,
} from "./geometry";
import { STROKE_COLORS, FILL_COLORS, STICKY_COLORS, textLayout, mdParseLine, mdWrapLine } from "./draw";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const css = (c: Rgba, mul = 1): string => {
  const r = Math.round(c[0] * 255), g = Math.round(c[1] * 255), b = Math.round(c[2] * 255);
  const a = c[3] * mul;
  return a >= 0.999 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a.toFixed(3)})`;
};

const n = (v: number) => Math.round(v * 100) / 100;

function fontFam(font: string | undefined): string {
  if (font === "mono") return "'JetBrains Mono', monospace";
  if (font === "inter") return "Inter, system-ui, sans-serif";
  return "Caveat, 'Segoe Print', cursive";
}

/** World-space AABB of one item (bound linears use resolved endpoints). */
function itemAabb(it: WbItem, items: WbItem[], measure: MeasureFn): Frame {
  if ((it.kind === "line" || it.kind === "arrow") && (it.bindStart || it.bindEnd)) {
    const pts = resolvedPoints(it, items, measure);
    const c = frameCenter(frameOf(it, measure));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const p = it.angle ? rot(pts[i]!, pts[i + 1]!, c.x, c.y, it.angle) : { x: pts[i]!, y: pts[i + 1]! };
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    if (isFinite(x0)) return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  const f = frameOf(it, measure);
  if (!it.angle) return f;
  const c = frameCenter(f);
  const cs = [[f.x, f.y], [f.x + f.w, f.y], [f.x + f.w, f.y + f.h], [f.x, f.y + f.h]]
    .map(([x, y]) => rot(x!, y!, c.x, c.y, it.angle));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  cs.forEach(p => {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  });
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function wbBounds(items: WbItem[], measure: MeasureFn): Frame {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  items.forEach(it => {
    const b = itemAabb(it, items, measure);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  });
  if (!isFinite(x0)) return { x: 0, y: 0, w: 640, h: 480 };
  const pad = 24;
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}

function strokeAttrs(it: WbItem): string {
  const col = STROKE_COLORS[it.color % STROKE_COLORS.length]!;
  let s = `stroke="${css(col)}" stroke-width="${n(it.size)}" stroke-linecap="round" stroke-linejoin="round"`;
  if (it.strokeStyle === "dashed") s += ` stroke-dasharray="${n(it.size * 4)},${n(it.size * 3)}"`;
  if (it.strokeStyle === "dotted") s += ` stroke-dasharray="0.1,${n(it.size * 2.4)}" stroke-linecap="round"`;
  if ((it.opacity ?? 1) < 0.999) s += ` opacity="${n(it.opacity)}"`;
  return s;
}

function rotAttr(it: WbItem, f: Frame): string {
  if (!it.angle) return "";
  const c = frameCenter(f);
  return ` transform="rotate(${n(it.angle * 180 / Math.PI)} ${n(c.x)} ${n(c.y)})"`;
}

function fillSvg(it: WbItem, f: Frame): string {
  if (it.fill < 0) return "";
  const col = FILL_COLORS[it.fill % FILL_COLORS.length]!;
  if (it.fillStyle === "solid") return `fill="${css(col)}"`;
  return `fill="url(#hatch-${it.id})"`;
}

/** Per-item hatch pattern defs (a <pattern> avoids clip-path plumbing). */
function hatchDef(it: WbItem): string {
  const col = FILL_COLORS[it.fill % FILL_COLORS.length]!;
  const c = `stroke="${css(col)}" stroke-width="${n(it.size * 0.55)}"`;
  const l1 = `<line x1="0" y1="0" x2="8" y2="8" ${c}/>`;
  const l2 = it.fillStyle === "cross" ? `<line x1="8" y1="0" x2="0" y2="8" ${c}/>` : "";
  return `<pattern id="hatch-${it.id}" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(0)">${l1}${l2}</pattern>`;
}

function arrowheadSvg(kind: string | undefined, tipX: number, tipY: number, ang: number,
  lw: number, color: string): string {
  if (!kind || kind === "none") return "";
  const L = 14 + lw * 2;
  const back = (a: number): [number, number] =>
    [tipX - Math.cos(a) * L, tipY - Math.sin(a) * L];
  const [lx, ly] = back(ang - 0.42), [rx, ry] = back(ang + 0.42);
  if (kind === "dot") return `<circle cx="${n(tipX)}" cy="${n(tipY)}" r="${n(lw + 3)}" fill="${color}"/>`;
  if (kind === "triangle") return `<polygon points="${n(tipX)},${n(tipY)} ${n(lx)},${n(ly)} ${n(rx)},${n(ry)}" fill="${color}"/>`;
  return `<polyline points="${n(lx)},${n(ly)} ${n(tipX)},${n(tipY)} ${n(rx)},${n(ry)}" fill="none" stroke="${color}" stroke-width="${n(lw)}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function textLinesSvg(it: WbItem, f: Frame): string {
  const str = it.kind === "sticky" || it.kind === "text" ? (it.text ?? "") : (it.boundText ?? "");
  if (!str) return "";
  const fs = wbFontSize(it);
  const col = it.kind === "sticky" ? "rgb(30,30,34)" : css(STROKE_COLORS[it.color % STROKE_COLORS.length]!);
  const fam = fontFam(it.font ?? (it.kind === "sticky" ? "inter" : "hand"));

  if (it.kind === "sticky") {
    // Markdown-styled: headings, bullets, inline bold/italic/code.
    const maxW = Math.max(24, f.w * 0.9 - 10);
    const mf = (_face: string, pxW: number, s: string) => s.length * pxW * 0.52;
    let wy = f.y + 26;
    const parts: string[] = [];
    str.split("\n").forEach(raw => {
      const src = mdParseLine(raw, it.font);
      const vis = mdWrapLine(src, it.font, fs, maxW, mf);
      vis.forEach(vl => {
        const px = fs * vl.sizeMul;
        let inner = "";
        vl.segs.forEach(seg => {
          const w700 = seg.face.includes(":700"), ital = seg.face.includes(":italic");
          const mono = seg.face.startsWith("jetbrains");
          inner += `<tspan${w700 ? ' font-weight="700"' : ""}${ital ? ' font-style="italic"' : ""}${mono ? ` font-family="${fontFam("mono")}"` : ""}>${esc(seg.str)}</tspan>`;
        });
        parts.push(`<text x="${n(f.x + 12 + vl.indent)}" y="${n(wy + px * 0.82)}" font-size="${n(px)}" fill="${col}">${inner || " "}</text>`);
        wy += px * 1.25;
      });
    });
    return `<g font-family="${fam}">${parts.join("")}</g>`;
  }

  const lay = textLayout(it, str, measureStub(it));
  const isBound = it.kind !== "text";
  const totalH = lay.lines.length * fs * 1.25;
  let wy = f.y + (isBound ? Math.max(8, (f.h - totalH) / 2) : 8);
  const parts: string[] = [];
  lay.lines.forEach(l => {
    const wx = isBound ? f.x + f.w / 2 - l.w / 2 : f.x + lay.padX;
    parts.push(`<text x="${n(wx)}" y="${n(wy + fs * 0.82)}" font-size="${n(fs)}" fill="${col}">${esc(l.str) || " "}</text>`);
    wy += fs * 1.25;
  });
  return `<g font-family="${fam}">${parts.join("")}</g>`;
}

// crude width stub for SVG wrapping — real metrics live in the runtime cache
function measureStub(it: WbItem): MeasureFn {
  return (_f, size, t) => t.length * size * (it.font === "hand" ? 0.45 : 0.52);
}

export function itemSvg(it: WbItem, items: WbItem[], measure: MeasureFn,
  imgData?: (asset: string) => string | null): string {
  const f = frameOf(it, measure);
  const st = strokeAttrs(it);
  const tr = rotAttr(it, f);
  const strokeCol = css(STROKE_COLORS[it.color % STROKE_COLORS.length]!);
  switch (it.kind) {
    case "stroke": {
      const pts = resolvedPoints(it, items, measure);
      const pp: string[] = [];
      for (let i = 0; i + 1 < pts.length; i += 2) pp.push(`${n(pts[i]!)},${n(pts[i + 1]!)}`);
      return `<polyline points="${pp.join(" ")}" fill="none" ${st}${tr}/>`;
    }
    case "rect": {
      const rx = it.round ? Math.min(f.w, f.h) * 0.16 : 0;
      return `<rect x="${n(f.x)}" y="${n(f.y)}" width="${n(f.w)}" height="${n(f.h)}" rx="${n(rx)}" ${fillSvg(it, f)} ${st}${tr}/>`
        + textLinesSvg(it, f);
    }
    case "diamond": {
      const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
      return `<polygon points="${n(cx)},${n(f.y)} ${n(f.x + f.w)},${n(cy)} ${n(cx)},${n(f.y + f.h)} ${n(f.x)},${n(cy)}" ${fillSvg(it, f)} ${st}${tr}/>`
        + textLinesSvg(it, f);
    }
    case "ellipse": {
      return `<ellipse cx="${n(f.x + f.w / 2)}" cy="${n(f.y + f.h / 2)}" rx="${n(f.w / 2)}" ry="${n(f.h / 2)}" ${fillSvg(it, f)} ${st}${tr}/>`
        + textLinesSvg(it, f);
    }
    case "line":
    case "arrow": {
      const pts = resolvedPoints(it, items, measure);
      const pp: string[] = [];
      for (let i = 0; i + 1 < pts.length; i += 2) pp.push(`${n(pts[i]!)},${n(pts[i + 1]!)}`);
      let s = `<polyline points="${pp.join(" ")}" fill="none" ${st}${tr}/>`;
      const np = pts.length / 2;
      if (np >= 2) {
        const ea = Math.atan2(pts[np * 2 - 1]! - pts[np * 2 - 3]!, pts[np * 2 - 2]! - pts[np * 2 - 4]!);
        s += arrowheadSvg(it.endArrow ?? (it.kind === "arrow" ? "arrow" : "none"),
          pts[np * 2 - 2]!, pts[np * 2 - 1]!, ea, it.size, strokeCol);
        const sa = Math.atan2(pts[1]! - pts[3]!, pts[0]! - pts[2]!);
        s += arrowheadSvg(it.startArrow, pts[0]!, pts[1]!, sa, it.size, strokeCol);
      }
      return s + textLinesSvg(it, f);
    }
    case "image": {
      const b64 = it.asset && imgData ? imgData(it.asset) : null;
      if (b64) {
        const op = (it.opacity ?? 1) < 0.999 ? ` opacity="${n(it.opacity)}"` : "";
        return `<image x="${n(f.x)}" y="${n(f.y)}" width="${n(f.w)}" height="${n(f.h)}" href="data:image/png;base64,${b64}"${op}${tr}/>`;
      }
      return `<rect x="${n(f.x)}" y="${n(f.y)}" width="${n(f.w)}" height="${n(f.h)}" fill="none" stroke="${strokeCol}" stroke-width="${n(it.size)}" stroke-dasharray="6,4"${tr}/>`
        + `<text x="${n(f.x + f.w / 2)}" y="${n(f.y + f.h / 2)}" font-size="${n(Math.min(18, f.h * 0.4))}" fill="${strokeCol}" text-anchor="middle">image</text>`;
    }
    case "text":
      return `<g${tr}>${textLinesSvg(it, f)}</g>`;
    case "sticky": {
      const bg = STICKY_COLORS[it.fill >= 0 ? it.fill % STICKY_COLORS.length : 0]!;
      return `<rect x="${n(f.x)}" y="${n(f.y)}" width="${n(f.w)}" height="${n(f.h)}" rx="7" fill="${css(bg)}" stroke="rgba(0,0,0,0.15)" stroke-width="1"${tr}/>`
        + `<g${tr}>${textLinesSvg(it, f)}</g>`;
    }
  }
  return "";
}

/** Full SVG document for the whiteboard contents (cropped to content + pad). */
export function wbSvg(wb: WbContent, measure: MeasureFn,
  imgData?: (asset: string) => string | null): string {
  const b = wbBounds(wb.items, measure);
  const defs: string[] = [];
  const body: string[] = [];
  wb.items.forEach(it => {
    if (it.fill >= 0 && it.fillStyle !== "solid" && it.kind !== "sticky") defs.push(hatchDef(it));
    body.push(itemSvg(it, wb.items, measure, imgData));
  });
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(b.x)} ${n(b.y)} ${n(b.w)} ${n(b.h)}" width="${n(b.w)}" height="${n(b.h)}">`,
    `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" fill="#ffffff"/>`,
    defs.length ? `<defs>${defs.join("")}</defs>` : "",
    ...body,
    `</svg>`,
  ].join("\n");
}
