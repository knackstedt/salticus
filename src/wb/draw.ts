// ============================================================================
// wb/draw.ts — whiteboard item renderer. Draws every item kind with
// Excalidraw-style hand-drawn strokes, fill styles (solid / hachure /
// cross-hatch), dash patterns, arrowheads, and container-bound text.
//
// Everything flows through WbPainter: world→screen transforms, rough-stroke
// emission, dashed polylines, clipped hatching, and convex scanline fills.
// ============================================================================

import type { GpuTextPass, Rgba } from "../text/gpu-text";
import type { RunCache } from "../text/run-cache";
import { FALLBACK_FACES } from "../text/fonts";
import type { TextAtlas, AtlasRegion } from "../text/atlas";
import type { ThemeTokens } from "../app/theme";
import { wbFontSize, type WbItem } from "./model";
import {
  frameOf, frameCenter, resolvedPoints, faceFor, LINE_H,
  type MeasureFn, type Frame,
} from "./geometry";

// ── palettes ────────────────────────────────────────────────────────────────

export const STROKE_COLORS: Rgba[] = [
  [0.92, 0.92, 0.92, 1], // ink
  [0.93, 0.42, 0.46, 1], // red
  [0.95, 0.65, 0.28, 1], // orange
  [0.48, 0.80, 0.48, 1], // green
  [0.38, 0.68, 0.98, 1], // blue
  [0.68, 0.58, 0.98, 1], // violet
];
export const STROKE_NAMES = ["Ink", "Red", "Orange", "Green", "Blue", "Violet"];

/** Fill swatches — muted, slightly translucent so shapes stay sketchy. */
export const FILL_COLORS: Rgba[] = [
  [0.83, 0.83, 0.83, 0.28],
  [0.88, 0.36, 0.40, 0.32],
  [0.90, 0.58, 0.22, 0.34],
  [0.40, 0.72, 0.40, 0.32],
  [0.32, 0.60, 0.92, 0.34],
  [0.60, 0.50, 0.94, 0.34],
];

export const STICKY_COLORS: Rgba[] = [
  [0.25, 0.25, 0.25, 1],
  [0.42, 0.28, 0.30, 1],
  [0.46, 0.36, 0.20, 1],
  [0.24, 0.36, 0.28, 1],
  [0.24, 0.32, 0.44, 1],
  [0.34, 0.28, 0.46, 1],
];

export function hex(s: string): Rgba {
  const h = s.slice(1);
  const n = parseInt(h.slice(0, 6), 16);
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
}

export function withAlpha(c: Rgba, a: number): Rgba {
  return [c[0], c[1], c[2], c[3] * a];
}

// ── seeded rng (deterministic wobble) ───────────────────────────────────────

function hash32(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 ^ s.charCodeAt(i)) >>> 0;
  return h;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── text layout (shared with the surface for caret math) ────────────────────

export interface TextLine { str: string; start: number; w: number }
export interface TextLayout {
  lines: TextLine[];
  lineH: number;
  boxW: number;
  boxH: number;
  /** Horizontal inset applied to wrapped text (container padding). */
  padX: number;
  padY: number;
}

/** Layout an item's text field. For containers this wraps to the inscribed
 *  box; for text items it keeps raw lines. */
export function textLayout(it: WbItem, text: string, measure: MeasureFn): TextLayout {
  const size = wbFontSize(it);
  const lineH = size * LINE_H;
  if (it.kind === "text") {
    const lines: TextLine[] = [];
    let start = 0;
    let boxW = 4;
    text.split("\n").forEach(raw => {
      const w = measure(it.font, size, raw) + 2;
      lines.push({ str: raw, start, w });
      boxW = Math.max(boxW, w);
      start += raw.length + 1;
    });
    return { lines, lineH, boxW, boxH: Math.max(1, lines.length) * lineH, padX: 0, padY: 0 };
  }
  // Containers: inscribed box (narrower for diamond/ellipse), small padding.
  const shrink = it.kind === "diamond" ? 0.52 : it.kind === "ellipse" ? 0.72 : 0.9;
  const boxW = Math.max(20, it.w * shrink);
  const padX = it.kind === "sticky" ? 12 : Math.max(6, (it.w - boxW) / 2);
  const padY = it.kind === "sticky" ? 34 : 8;
  const lines = wrapIndexed(text, it.font, size, boxW - 8, measure);
  return { lines, lineH, boxW, boxH: lines.length * lineH + padY * 2, padX, padY };
}

/** Word-wrap with source-index tracking — every emitted line knows where it
 *  starts in `text`, which is what makes wrapped-text caret math possible. */
export function wrapIndexed(text: string, font: string | undefined, size: number,
  maxW: number, measure: MeasureFn): TextLine[] {
  const lines: TextLine[] = [];
  let cur = "", curStart = 0;
  const flush = () => {
    lines.push({ str: cur, start: curStart, w: measure(font, size, cur) + 2 });
    cur = "";
  };
  const n = text.length;
  for (let i = 0; i < n;) {
    if (text[i] === "\n") { flush(); i++; curStart = i; continue; }
    // Grab the next word [i, j).
    let j = i;
    for (; j < n && text[j] !== " " && text[j] !== "\n"; j++) {}
    const word = text.slice(i, j);
    const cand = cur ? cur + " " + word : word;
    if (cur && measure(font, size, cand) > maxW) {
      flush();
      cur = word;
      curStart = i;
    } else {
      cur = cand;
    }
    i = j;
    // Skip a single space separator (its width was accounted in cand).
    if (text[i] === " ") i++;
    if (i >= n) break;
    if (text[i] === "\n") continue;
    // If we just flushed, the next word starts the new line.
    if (!cur) curStart = i;
  }
  if (cur || lines.length === 0) flush();
  return lines;
}

// ── markdown-lite (sticky notes) ──────────────────────────────────────────────
//
// Supported: `#`/`##`/`###` headings, `-`/`*`/`•` bullets, `N.` lists,
// `>` quotes, `**bold**`, `*italic*`, `` `code` ``. Rendered styling only —
// while editing a sticky the raw source shows so the markers stay editable.

export interface MdSeg { str: string; face: string }
export interface MdSrcLine { segs: MdSeg[]; sizeMul: number; hang: number }
export interface MdVisLine { segs: MdSeg[]; w: number; sizeMul: number; indent: number }

function mdSegFace(font: string | undefined, bold: boolean, ital: boolean, mono: boolean): string {
  return faceFor(mono ? "mono" : font, bold ? 700 : 400, ital && font !== "hand" && !mono);
}

export function mdParseLine(raw: string, font: string | undefined): MdSrcLine {
  let sizeMul = 1, hang = 0, s = raw;
  const hm = /^(#{1,4})\s+(.*)$/.exec(s);
  if (hm) {
    sizeMul = [1.6, 1.35, 1.18, 1.05][Math.min(4, hm[1]!.length) - 1]!;
    s = hm[2]!;
  } else if (/^\s*[-*•]\s+/.test(s)) {
    s = "•  " + s.replace(/^\s*[-*•]\s+/, ""); hang = 9;
  } else if (/^\s*\d+\.\s+/.test(s)) {
    s = s.replace(/^\s*/, ""); hang = 9;
  } else if (/^>\s+/.test(s)) {
    s = s.replace(/^>\s+/, ""); hang = 10;
  }
  const segs: MdSeg[] = [];
  let bold = !!hm, ital = false, mono = false, cur = "";
  const flush = () => {
    if (cur) segs.push({ str: cur, face: mdSegFace(font, bold, ital, mono) });
    cur = "";
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (!mono && ch === "*" && s[i + 1] === "*") { flush(); bold = !bold; i++; continue; }
    if (!mono && ch === "*") { flush(); ital = !ital; continue; }
    if (ch === "`") { flush(); mono = !mono; continue; }
    cur += ch;
  }
  flush();
  return { segs, sizeMul, hang };
}

/** Wrap one parsed line into visual lines at `maxW` world px. */
export function mdWrapLine(l: MdSrcLine, font: string | undefined, fs: number, maxW: number,
  mf: (face: string, sizeW: number, s: string) => number): MdVisLine[] {
  const px = fs * l.sizeMul;
  const toks: { str: string; face: string; sp: boolean }[] = [];
  for (let si = 0; si < l.segs.length; si++) {
    const seg = l.segs[si]!;
    const parts = seg.str.split(/(\s+)/);
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi]!;
      if (part) toks.push({ str: part, face: seg.face, sp: /^\s+$/.test(part) });
    }
  }
  const out: MdVisLine[] = [];
  let segs: MdSeg[] = [], w = 0, indent = 0;
  const pushTok = (str: string, face: string) => {
    const last = segs[segs.length - 1];
    if (last && last.face === face) last.str += str; else segs.push({ str, face });
  };
  const flush = () => {
    if (segs.length) out.push({ segs, w, sizeMul: l.sizeMul, indent });
    segs = []; w = 0; indent = l.hang;
  };
  for (let ti = 0; ti < toks.length; ti++) {
    const tok = toks[ti]!;
    const tw = mf(tok.face, px, tok.str);
    if (!tok.sp && w + tw > maxW && segs.length) flush();
    if (tok.sp && !segs.length) continue;
    pushTok(tok.str, tok.face);
    w += tw;
  }
  flush();
  if (!out.length) {
    out.push({ segs: [{ str: " ", face: faceFor(font) }], w: 0, sizeMul: l.sizeMul, indent: 0 });
  }
  return out;
}

// ── painter ─────────────────────────────────────────────────────────────────

export interface PainterOpts {
  pass: GpuTextPass;
  cache: RunCache;
  atlas: TextAtlas;
  theme: ThemeTokens;
  /** Resolve an image asset id to an atlas region (image atlas). */
  images?: (asset: string) => { region: AtlasRegion; atlas: TextAtlas } | null;
  /** world→screen transforms */
  w2sX: (x: number) => number;
  w2sY: (y: number) => number;
  zoom: number;
}

export class WbPainter {
  readonly pass: GpuTextPass;
  readonly cache: RunCache;
  readonly atlas: TextAtlas;
  readonly t: ThemeTokens;
  readonly zoom: number;
  private w2sX: (x: number) => number;
  private w2sY: (y: number) => number;
  private images?: (asset: string) => { region: AtlasRegion; atlas: TextAtlas } | null;

  constructor(o: PainterOpts) {
    this.pass = o.pass;
    this.cache = o.cache;
    this.atlas = o.atlas;
    this.t = o.theme;
    this.zoom = o.zoom;
    this.w2sX = o.w2sX;
    this.w2sY = o.w2sY;
    this.images = o.images;
  }

  s(wx: number, wy: number): [number, number] {
    return [this.w2sX(wx), this.w2sY(wy)];
  }

  /** Measure in WORLD units (font size = world px). */
  measure: MeasureFn = (font, size, text) => {
    if (!text) return 0;
    const face = faceFor(font);
    return this.runAdvance(face, Math.max(4, size), text) ?? text.length * size * (font === "hand" ? 0.42 : 0.52);
  };

  private fallbackChain(): string[] {
    return FALLBACK_FACES.map(f => f.key).filter(k => this.cache.hasFace(k));
  }

  /** Advance of a string honoring fallback run splits — missing
   *  glyphs measure in the fallback face, not the primary's .notdef. */
  private runAdvance(face: string, sizePx: number, str: string): number | null {
    if (!this.cache.hasFace(face)) return null;
    let total = 0;
    this.cache.fallbackPieces(face, sizePx, str, this.fallbackChain()).forEach(p => {
      total += this.cache.getRun(p.face, sizePx, p.text)?.advance ?? 0;
    });
    return total;
  }

  /** Draw one glyph-run piece at penX; returns its advance. */
  private drawPiece(penX: number, y: number, face: string, sizePx: number, str: string, color: Rgba): number {
    if (!str) return 0;
    const chunk = this.cache.getChunk(face, sizePx, str);
    if (chunk?.region) {
      this.pass.text(Math.round(penX + chunk.inkX), Math.round(y), chunk.w, chunk.h,
        { region: chunk.region, atlasSize: this.atlas.size, color: chunk.color }, color);
    }
    return this.cache.getRun(face, sizePx, str)?.advance ?? 0;
  }

  /** Draw a text run; x,y = bitmap top-left (screen px). Splits emoji and
   *  other uncovered glyphs into fallback-face pieces. */
  text(x: number, y: number, face: string, sizePx: number, str: string, color: Rgba): void {
    const size = Math.max(4, sizePx);
    let penX = x;
    this.cache.fallbackPieces(face, size, str, this.fallbackChain()).forEach(p => {
      // ZWJ pieces ride the primary face — invisible, zero-advance; skip.
      if (/^\u200D+$/.test(p.text)) return;
      penX += this.drawPiece(penX, y, p.face, size, p.text, color);
    });
  }

  /** Convenience: draw `str` so its BASELINE sits at `baselineY` (screen). */
  textBaseline(x: number, y: number, face: string, sizePx: number, str: string, color: Rgba): void {
    this.text(x, y, face, sizePx, str || " ", color);
  }

  /** Advance width of a run at a screen-px size. */
  advance(face: string, sizePx: number, str: string): number {
    return this.runAdvance(face, Math.max(4, sizePx), str) ?? str.length * sizePx * 0.52;
  }

  // ── stroke emission ──────────────────────────────────────────────────────

  /** Polyline in screen px. `dash` = [on, off] world-px pattern; dotted
   *  emits round dots. Rotation applies via pass.rotation (set by caller). */
  strokePath(pts: number[], r: number, color: Rgba, dash?: number[] | "dot"): void {
    const p = this.pass;
    if (pts.length < 4) {
      if (pts.length === 2) p.capsule(pts[0]!, pts[1]!, pts[0]! + 0.01, pts[1]! + 0.01, r, color);
      return;
    }
    if (!dash) {
      p.stroke(pts, r, color);
      return;
    }
    if (dash === "dot") {
      // Round dots spaced ~2.6× the stroke radius.
      const spacing = Math.max(r * 2.6, 2.5);
      let acc = 0;
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const x0 = pts[i]!, y0 = pts[i + 1]!, x1 = pts[i + 2]!, y1 = pts[i + 3]!;
        const len = Math.hypot(x1 - x0, y1 - y0);
        const ux = (x1 - x0) / (len || 1), uy = (y1 - y0) / (len || 1);
        let d = (spacing - (acc % spacing)) % spacing;
        if (d === 0) d = spacing;
        for (; d <= len; d += spacing) {
          p.capsule(x0 + ux * d, y0 + uy * d, x0 + ux * d + 0.01, y0 + uy * d + 0.01, r, color);
        }
        acc += len;
      }
      return;
    }
    const on = dash[0]!, off = dash[1]!;
    let acc = 0; // distance along path
    let phase = acc % (on + off);
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const x0 = pts[i]!, y0 = pts[i + 1]!, x1 = pts[i + 2]!, y1 = pts[i + 3]!;
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 0.001) continue;
      const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
      for (let d = 0; d < len;) {
        const gd = acc + d;
        const inDash = (gd % (on + off)) < on;
        const segEnd = inDash
          ? Math.min(len, d + (on - (gd % (on + off))))
          : Math.min(len, d + ((on + off) - (gd % (on + off))));
        if (inDash) {
          p.capsule(x0 + ux * d, y0 + uy * d, x0 + ux * segEnd, y0 + uy * segEnd, r, color);
        }
        d = segEnd;
      }
      acc += len;
    }
    void phase;
  }

  /** Jittered polyline for sketchy outlines. `roughness` picks pass count +
   *  jitter amplitude. */
  roughStroke(corners: number[], seed: string, closed: boolean, lw: number,
    color: Rgba, roughness: number, dash?: number[] | "dot"): void {
    const passes = roughness <= 0 ? 1 : 2;
    const jitter = roughness <= 0 ? 0.25 : roughness === 1 ? 1.15 : 2.3;
    for (let i = 0; i < passes; i++) {
      const pts = jitterPolyline(corners, seed, i, jitter, closed, roughness);
      this.strokePath(pts, lw, i === 1 ? withAlpha(color, 0.85) : color, dash);
    }
  }

  /** Convex-polygon scanline fill (diamond, triangle). Screen-px vertices. */
  fillPoly(pts: number[], color: Rgba): void {
    const p = this.pass;
    if (pts.length < 6) return;
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < pts.length; i += 2) { minY = Math.min(minY, pts[i]!); maxY = Math.max(maxY, pts[i]!); }
    const y0 = Math.floor(minY), y1 = Math.ceil(maxY);
    const n = pts.length / 2;
    for (let y = y0; y <= y1; y++) {
      const yy = y + 0.5;
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < n; i++) {
        const ax = pts[i * 2]!, ay = pts[i * 2 + 1]!;
        const bx = pts[((i + 1) % n) * 2]!, by = pts[((i + 1) % n) * 2 + 1]!;
        if ((ay <= yy && by > yy) || (by <= yy && ay > yy)) {
          const x = ax + (yy - ay) / (by - ay) * (bx - ax);
          lo = Math.min(lo, x); hi = Math.max(hi, x);
        }
      }
      if (isFinite(lo) && hi > lo) p.rect(lo, y, hi - lo, 1, color);
    }
  }

  /** Clip a diagonal hatch line to a shape; returns clipped segment in
   *  screen px or null. Line given as parametric point + unit dir. */
  private hatchSeg(kind: WbItem["kind"], f: Frame, px: number, py: number,
    ux: number, uy: number): [number, number, number, number] | null {
    // inside() in local frame, same tests as geometry.outlineHit.
    const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
    const rx = Math.max(f.w / 2, 1e-3), ry = Math.max(f.h / 2, 1e-3);
    const inside = (x: number, y: number): number => {
      if (kind === "ellipse") {
        const u = (x - cx) / rx, v = (y - cy) / ry;
        return u * u + v * v - 1;
      }
      if (kind === "diamond") {
        return Math.abs((x - cx) / rx) + Math.abs((y - cy) / ry) - 1;
      }
      const u = Math.abs((x - cx) / rx) - 1, v = Math.abs((y - cy) / ry) - 1;
      return Math.max(u, v);
    };
    // March t along the line across the bbox diagonal; find inside-range
    // by bisection on both ends.
    const diag = Math.hypot(f.w, f.h) + 8;
    const t0 = -diag, t1 = diag;
    const ins = (t: number) => inside(px + ux * t, py + uy * t) <= 0;
    // Scan for the first inside sample, then refine.
    const N = 64;
    let a = NaN, b = NaN;
    let prevT = t0, prevIn = ins(t0);
    for (let i = 1; i <= N; i++) {
      const t = t0 + (t1 - t0) * (i / N);
      const cur = ins(t);
      if (cur && !prevIn && isNaN(a)) a = prevT;
      if (!cur && prevIn) b = t;
      prevT = t; prevIn = cur;
    }
    if (prevIn) b = t1;
    if (isNaN(a) || isNaN(b) || b <= a) return null;
    const refine = (tGuess: number, outward: number): number => {
      let lo = tGuess - diag / N, hi = tGuess + diag / N;
      for (let i = 0; i < 24; i++) {
        const m = (lo + hi) / 2;
        if (ins(m) === (outward < 0)) hi = m; else lo = m;
      }
      return (lo + hi) / 2;
    };
    a = refine(a, -1); b = refine(b, 1);
    return [px + ux * a, py + uy * a, px + ux * b, py + uy * b];
  }

  /** Hachure fill — clipped diagonal strokes. angle in radians. */
  hachure(kind: WbItem["kind"], f: Frame, seed: string, color: Rgba,
    cross: boolean, lw: number, roughness: number): void {
    const rnd = mulberry32(hash32(seed) + 97);
    const spacing = Math.max(5, 7 * this.zoom) * 1.2;
    (cross ? [Math.PI / 4, -Math.PI / 4] : [Math.PI / 4]).forEach(ang => {
      const ux = Math.cos(ang), uy = Math.sin(ang);
      const nx = -uy, ny = ux;
      // Sweep the hatch line along the normal across the bbox.
      const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
      const ext = Math.hypot(f.w, f.h) / 2 + spacing;
      for (let d = -ext; d <= ext; d += spacing) {
        const px = cx + nx * d + (rnd() - 0.5) * (roughness > 0 ? 2.2 : 0);
        const py = cy + ny * d + (rnd() - 0.5) * (roughness > 0 ? 2.2 : 0);
        const seg = this.hatchSeg(kind, f, px, py, ux, uy);
        if (!seg) continue;
        const [x0, y0] = this.s(seg[0], seg[1]);
        const [x1, y1] = this.s(seg[2], seg[3]);
        this.strokePath([x0, y0, x1, y1], lw, color);
      }
    });
  }

  /** Arrowhead at a segment tip. tip/dir in local world coords. */
  arrowhead(kind: string, tipX: number, tipY: number, segAngle: number,
    lw: number, color: Rgba, roughness: number): void {
    const z = this.zoom;
    const len = Math.min(22 * z + lw * 3, 60);
    if (kind === "dot") {
      const r = Math.max(lw * 1.7, 2.5);
      const [sx, sy] = this.s(tipX, tipY);
      this.pass.ellipse(sx - r, sy - r, r * 2, r * 2, color);
      return;
    }
    const a0 = segAngle + Math.PI - 0.42;
    const a1 = segAngle + Math.PI + 0.42;
    const hx0 = tipX + Math.cos(a0) * (len / z), hy0 = tipY + Math.sin(a0) * (len / z);
    const hx1 = tipX + Math.cos(a1) * (len / z), hy1 = tipY + Math.sin(a1) * (len / z);
    if (kind === "triangle") {
      const [tX, tY] = this.s(tipX, tipY);
      const [ax, ay] = this.s(hx0, hy0);
      const [bx, by] = this.s(hx1, hy1);
      this.fillPoly([tX, tY, ax, ay, bx, by], color);
      return;
    }
    // "arrow" — two sketchy barbs.
    const corners = [this.s(hx0, hy0)[0], this.s(hx0, hy0)[1],
      this.s(tipX, tipY)[0], this.s(tipX, tipY)[1],
      this.s(hx1, hy1)[0], this.s(hx1, hy1)[1]];
    this.roughStroke(corners, `ah${tipX.toFixed(1)},${tipY.toFixed(1)}`, false, lw, color, roughness);
  }

  // ── items ────────────────────────────────────────────────────────────────

  /** Draw any item. `edit` marks the field currently being text-edited. */
  drawItem(it: WbItem, items: WbItem[], opts: {
    edit?: { field: "text" | "boundText"; caret: number; anchor: number; blinkOn: boolean };
    isDraft?: boolean;
  } = {}): void {
    const p = this.pass;
    const z = this.zoom;
    const color = STROKE_COLORS[it.color % STROKE_COLORS.length]!;
    const fillC = it.fill >= 0 ? FILL_COLORS[it.fill % FILL_COLORS.length]! : null;
    const alpha = it.opacity ?? 1;
    const strokeC = withAlpha(color, alpha);
    const fillCA = fillC ? withAlpha(fillC, alpha) : null;
    const f = frameOf(it, this.measure);
    const c = frameCenter(f);
    const [scx, scy] = this.s(c.x, c.y);
    // Whole-item rotation — every quad pushed below rotates about the item's
    // screen-space center.
    const prevRot = p.rotation;
    p.rotation = it.angle ? { angle: it.angle, x: scx, y: scy } : null;
    const lw = Math.max(0.8, it.size * z * 0.55);
    const dashPat = it.strokeStyle === "dashed" ? [Math.max(6, lw * 4.5), Math.max(4, lw * 3)]
      : it.strokeStyle === "dotted" ? "dot" as const
      : undefined;

    switch (it.kind) {
      case "stroke": {
        const pts = resolvedPoints(it, items, this.measure);
        const sp: number[] = [];
        for (let i = 0; i + 1 < pts.length; i += 2) sp.push(this.w2sX(pts[i]!), this.w2sY(pts[i + 1]!));
        this.strokePath(smoothPath(sp), Math.max(0.8, it.size * z * 0.5), strokeC, dashPat);
        break;
      }
      case "rect": {
        const [sx, sy] = this.s(f.x, f.y);
        const w = f.w * z, h = f.h * z;
        const rad = it.round ? Math.min(w, h) * 0.16 : 0;
        if (fillCA) {
          if (it.fillStyle === "solid") {
            if (rad > 1) p.roundedRect(sx, sy, w, h, rad, fillCA); else p.rect(sx, sy, w, h, fillCA);
          } else {
            this.hachure("rect", f, it.id, withAlpha(fillCA, 0.8), it.fillStyle === "cross", lw * 0.6, it.roughness);
          }
        }
        const corners = rectCorners(f, rad, this);
        this.roughStroke(corners, it.id, true, lw, strokeC, it.roughness, dashPat);
        this.boundText(it, opts, c);
        break;
      }
      case "diamond": {
        const [sx, sy] = this.s(f.x, f.y);
        const w = f.w * z, h = f.h * z;
        const corners = [sx + w / 2, sy, sx + w, sy + h / 2, sx + w / 2, sy + h, sx, sy + h / 2];
        if (fillCA) {
          if (it.fillStyle === "solid") this.fillPoly(corners, fillCA);
          else this.hachure("diamond", f, it.id, withAlpha(fillCA, 0.8), it.fillStyle === "cross", lw * 0.6, it.roughness);
        }
        this.roughStroke(corners, it.id, true, lw, strokeC, it.roughness, dashPat);
        this.boundText(it, opts, c);
        break;
      }
      case "ellipse": {
        const [sx, sy] = this.s(f.x, f.y);
        const w = f.w * z, h = f.h * z;
        if (fillCA) {
          if (it.fillStyle === "solid") p.ellipse(sx, sy, w, h, fillCA);
          else this.hachure("ellipse", f, it.id, withAlpha(fillCA, 0.8), it.fillStyle === "cross", lw * 0.6, it.roughness);
        }
        const n = 30;
        const ring: number[] = [];
        for (let i = 0; i <= n; i++) {
          const a = (i / n) * Math.PI * 2;
          ring.push(sx + w / 2 + Math.cos(a) * w / 2, sy + h / 2 + Math.sin(a) * h / 2);
        }
        this.roughStroke(ring, it.id, true, lw, strokeC, it.roughness, dashPat);
        this.boundText(it, opts, c);
        break;
      }
      case "line":
      case "arrow": {
        const pts = resolvedPoints(it, items, this.measure);
        if (pts.length < 4) break;
        const sp: number[] = [];
        for (let i = 0; i + 1 < pts.length; i += 2) sp.push(this.w2sX(pts[i]!), this.w2sY(pts[i + 1]!));
        this.roughStroke(sp, it.id, false, lw, strokeC, it.roughness, dashPat);
        const head = it.kind === "arrow" ? (it.endArrow ?? "arrow") : it.endArrow;
        const tail = it.kind === "arrow" ? (it.startArrow ?? "none") : it.startArrow;
        if (head && head !== "none") {
          const a = Math.atan2(pts[pts.length - 1]! - pts[pts.length - 3]!, pts[pts.length - 2]! - pts[pts.length - 4]!);
          this.arrowhead(head, pts[pts.length - 2]!, pts[pts.length - 1]!, a, lw, strokeC, it.roughness);
        }
        if (tail && tail !== "none") {
          const a = Math.atan2(pts[1]! - pts[3]!, pts[0]! - pts[2]!);
          this.arrowhead(tail, pts[0]!, pts[1]!, a, lw, strokeC, it.roughness);
        }
        this.boundText(it, opts, c);
        break;
      }
      case "text": {
        const str = opts.edit?.field === "text" ? (it.text ?? "") : (it.text ?? "");
        this.textItem(it, str, opts.edit?.field === "text" ? opts.edit : undefined, color, f);
        break;
      }
      case "image": {
        const [sx, sy] = this.s(f.x, f.y);
        const w = f.w * z, h = f.h * z;
        const img = it.asset ? this.images?.(it.asset) : null;
        if (img) {
          p.text(sx, sy, w, h,
            { region: img.region, atlasSize: img.atlas.size, color: true, tex: img.atlas },
            [1, 1, 1, alpha]);
        } else {
          // Missing/undecodable asset — dashed placeholder + label.
          const c = withAlpha(color, alpha * 0.7);
          this.roughStroke(rectCorners(f, 0, this), it.id, true, lw, c, 1,
            [Math.max(6, lw * 4.5), Math.max(4, lw * 3)]);
          const label = it.asset ? "image" : "missing image";
          const fsPx = Math.max(9, Math.min(18, 14 * z, h * 0.4));
          const face = faceFor("inter");
          const tw = this.advance(face, fsPx, label);
          this.text(sx + (w - tw) / 2, sy + h / 2 - fsPx * 0.4, face, fsPx, label, c);
        }
        break;
      }
      case "sticky": {
        const [sx, sy] = this.s(f.x, f.y);
        const w = f.w * z, h = f.h * z;
        const bg = STICKY_COLORS[it.fill >= 0 ? it.fill % STICKY_COLORS.length : 0]!;
        p.roundedRect(sx + 3 * z, sy + 5 * z, w, h, 7, [0, 0, 0, 0.35]);
        p.roundedRect(sx, sy, w, h, 7, bg);
        const corners = rectCorners(f, 6 / z, this);
        this.roughStroke(corners, it.id, true, Math.max(1, 1.2 * z), [0.96, 0.96, 0.96, 0.4], 1);
        p.roundedRect(sx, sy, w, Math.min(h, 26 * z), 7, [1, 1, 1, 0.06]);
        const str = it.text ?? "";
        this.containerText(it, str, opts.edit?.field === "text" ? opts.edit : undefined,
          [0.94, 0.94, 0.94, 0.95], f, 26 / 1);
        break;
      }
    }
    p.rotation = prevRot;
  }

  /** Bound label inside a container, centered + wrapped. */
  private boundText(it: WbItem, opts: { edit?: { field: "text" | "boundText"; caret: number; anchor: number; blinkOn: boolean } }, c: { x: number; y: number }): void {
    const editing = opts.edit?.field === "boundText";
    const str = it.boundText ?? "";
    if (!str && !editing) return;
    if (it.kind !== "rect" && it.kind !== "diamond" && it.kind !== "ellipse" &&
        it.kind !== "line" && it.kind !== "arrow") return;
    this.containerText(it, str, editing ? opts.edit : undefined,
      withAlpha(STROKE_COLORS[it.color % STROKE_COLORS.length]!, it.opacity ?? 1), frameOf(it, this.measure), 0);
    void c;
  }

  /** Multi-line text with optional editing caret/selection. `topPad` = world
   *  px pushed down from the frame top (sticky header). */
  private containerText(it: WbItem, str: string,
    edit: { field: "text" | "boundText"; caret: number; anchor: number; blinkOn: boolean } | undefined,
    color: Rgba, f: Frame, topPad: number): void {
    const z = this.zoom;
    const fs = wbFontSize(it);
    const sizePx = Math.max(5, fs * z);
    const face = faceFor(it.font ?? (it.kind === "sticky" ? "inter" : "hand"));
    const lay = textLayout(it, str, this.measure);
    // Vertical centering for bound text; sticky/text top-align.
    const isBound = it.kind !== "sticky" && it.kind !== "text";
    if (it.kind === "sticky" && !edit) {
      this.mdText(it, str, color, f, topPad, fs);
      return;
    }
    const totalH = lay.lines.length * fs * LINE_H;
    let startWY = f.y + (isBound ? Math.max(topPad, (f.h - totalH) / 2) : topPad);
    const [fx0] = this.s(f.x, f.y);
    void fx0;
    for (let i = 0; i < lay.lines.length; i++) {
      const l = lay.lines[i]!;
      const lw = this.measure(it.font, fs, l.str) * z;
      let wx: number;
      if (isBound) wx = f.x + f.w / 2 - lw / (2 * z);
      else wx = f.x + lay.padX;
      const [tx, ty] = this.s(wx, startWY);
      const lineTop = ty + i * sizePx * LINE_H;
      // Bitmap top = line top + (lineH - glyph) padding.
      const bmpTop = lineTop + (sizePx * LINE_H - sizePx) * 0.35;
      this.text(tx, bmpTop, face, sizePx, l.str || " ", color);
    }
    if (edit) this.drawCaret(it, lay, str, edit, startWY, isBound, f);
  }

  /** Measure a styled face directly (world px). */
  private measureFace(face: string, sizeW: number, str: string): number {
    if (!str) return 0;
    const run = this.cache.getRun(face, Math.max(4, sizeW), str);
    return run?.advance ?? str.length * sizeW * 0.52;
  }

  /** Markdown-rendered sticky body — per-line headings/bullets/quotes and
   *  inline bold/italic/code segments. */
  private mdText(it: WbItem, str: string, color: Rgba, f: Frame, topPad: number, fs: number): void {
    const z = this.zoom;
    const maxW = Math.max(24, f.w * 0.9 - 10);
    const x0 = f.x + 12;
    let wy = f.y + topPad;
    const rawLines = str.split("\n");
    for (let ri = 0; ri < rawLines.length; ri++) {
      const src = mdParseLine(rawLines[ri]!, it.font);
      const vlines = mdWrapLine(src, it.font, fs, maxW, (fc, px, s) => this.measureFace(fc, px, s));
      for (let vi = 0; vi < vlines.length; vi++) {
        const vl = vlines[vi]!;
        const pxW = fs * vl.sizeMul;
        const sizePx = Math.max(5, pxW * z);
        let wx = x0 + vl.indent;
        const bmpTop = this.s(0, wy)[1]! + (sizePx * LINE_H - sizePx) * 0.35;
        for (let gi = 0; gi < vl.segs.length; gi++) {
          const seg = vl.segs[gi]!;
          const [tx] = this.s(wx, 0);
          this.text(tx, bmpTop, seg.face, sizePx, seg.str || " ", color);
          wx += this.measureFace(seg.face, pxW, seg.str);
        }
        wy += pxW * LINE_H;
      }
    }
  }

  /** Caret + selection highlight for the active edit session. */
  private drawCaret(it: WbItem, lay: TextLayout, str: string,
    edit: { caret: number; anchor: number; blinkOn: boolean }, startWY: number,
    isBound: boolean, f: Frame): void {
    const z = this.zoom;
    const p = this.pass;
    const accent = hex(this.t.accent);
    const lineOf = (idx: number): { line: TextLine; li: number } => {
      for (let i = 0; i < lay.lines.length; i++) {
        const l = lay.lines[i]!;
        if (idx <= l.start + l.str.length || i === lay.lines.length - 1) return { line: l, li: i };
      }
      return { line: lay.lines[lay.lines.length - 1]!, li: lay.lines.length - 1 };
    };
    const fs = wbFontSize(it);
    const xOf = (l: TextLine, col: number): number => {
      const prefix = l.str.slice(0, col);
      return this.measure(it.font, fs, prefix);
    };
    const baseX = (l: TextLine): number => {
      const lw = this.measure(it.font, fs, l.str);
      return isBound ? f.x + f.w / 2 - lw / 2 : f.x + lay.padX;
    };
    // Selection highlight.
    if (edit.anchor !== edit.caret) {
      const lo = Math.min(edit.anchor, edit.caret), hi = Math.max(edit.anchor, edit.caret);
      for (let i = 0; i < lay.lines.length; i++) {
        const l = lay.lines[i]!;
        const lEnd = l.start + l.str.length;
        const s = Math.max(lo, l.start), e = Math.min(hi, lEnd + (i < lay.lines.length - 1 ? 1 : 0));
        if (s > e || (s === e && s !== l.start)) continue;
        const x0 = baseX(l) + xOf(l, Math.max(0, s - l.start));
        const x1 = baseX(l) + xOf(l, Math.max(0, Math.min(e, lEnd) - l.start)) + (e > lEnd ? 6 : 0);
        const [sx, sy] = this.s(x0, startWY + i * fs * LINE_H);
        p.rect(sx, sy, Math.max(2, (x1 - x0) * z), fs * LINE_H * z, hex(this.t.selSoft));
      }
    }
    if (!edit.blinkOn) return;
    const { line, li } = lineOf(edit.caret);
    const col = Math.max(0, Math.min(edit.caret - line.start, line.str.length));
    const cx = baseX(line) + xOf(line, col);
    const [sx, sy] = this.s(cx, startWY + li * fs * LINE_H);
    p.rect(sx, sy + fs * 0.1 * z, Math.max(1.4, 1.4 * z * 0.5), fs * LINE_H * z * 0.85, accent);
  }

  /** Free text item. */
  private textItem(it: WbItem, str: string,
    edit: { field: "text" | "boundText"; caret: number; anchor: number; blinkOn: boolean } | undefined,
    color: Rgba, f: Frame): void {
    const z = this.zoom;
    const sizePx = Math.max(5, it.size * z);
    const face = faceFor(it.font ?? "hand");
    const lines = str.split("\n");
    const [fx] = this.s(f.x, f.y);
    void fx;
    for (let i = 0; i < lines.length; i++) {
      const [tx, ty] = this.s(f.x, f.y + i * it.size * LINE_H);
      const bmpTop = ty + (sizePx * LINE_H - sizePx) * 0.35;
      this.text(tx, bmpTop, face, sizePx, lines[i] || " ", withAlpha(color, it.opacity ?? 1));
    }
    if (edit) {
      const lay = textLayout(it, str, this.measure);
      this.drawCaret(it, lay, str, edit, f.y, false, f);
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Screen-space rect corners, subdivided + corner-cut for rounding. */
function rectCorners(f: Frame, radWorld: number, pt: WbPainter): number[] {
  const [x0, y0] = pt.s(f.x, f.y);
  const [x1, y1] = pt.s(f.x + f.w, f.y + f.h);
  const r = Math.min(radWorld * pt.zoom, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2);
  if (r < 1.5) return [x0, y0, x1, y0, x1, y1, x0, y1];
  const n = 3;
  const out: number[] = [];
  const arc = (cx: number, cy: number, a0: number, a1: number) => {
    for (let i = 0; i <= n; i++) {
      const a = a0 + (a1 - a0) * (i / n);
      out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  };
  arc(x1 - r, y0 + r, -Math.PI / 2, 0);
  arc(x1 - r, y1 - r, 0, Math.PI / 2);
  arc(x0 + r, y1 - r, Math.PI / 2, Math.PI);
  arc(x0 + r, y0 + r, Math.PI, Math.PI * 1.5);
  return out;
}

/** Subdivide a screen-px polyline and jitter interior points — sketchy edge. */
function jitterPolyline(pts: number[], seed: string, passIdx: number,
  jitter: number, closed: boolean, roughness: number): number[] {
  const rnd = mulberry32(hash32(seed) + passIdx * 7919);
  const out: number[] = [];
  const n = pts.length / 2;
  const edges = closed ? n : n - 1;
  for (let i = 0; i < edges; i++) {
    const x0 = pts[i * 2]!, y0 = pts[i * 2 + 1]!;
    const x1 = pts[((i + 1) % n) * 2]!, y1 = pts[((i + 1) % n) * 2 + 1]!;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const segs = Math.max(1, Math.min(12, Math.round(len / 42)));
    for (let j = i === 0 ? 0 : 1; j <= segs; j++) {
      const t = j / segs;
      const isEnd = j === 0 || j === segs;
      const jj = isEnd ? jitter * 0.35 : jitter;
      out.push(
        x0 + (x1 - x0) * t + (rnd() - 0.5) * 2 * jj,
        y0 + (y1 - y0) * t + (rnd() - 0.5) * 2 * jj,
      );
    }
  }
  if (closed && out.length >= 2) out.push(out[0]!, out[1]!);
  void roughness;
  return out;
}

/** Quadratic-midpoint smoothing for pen strokes (screen px). */
export function smoothPath(pts: number[]): number[] {
  const n = pts.length / 2;
  if (n < 3) return pts;
  const out: number[] = [pts[0]!, pts[1]!];
  for (let i = 1; i < n - 1; i++) {
    const x0 = pts[i * 2]!, y0 = pts[i * 2 + 1]!;
    const x1 = pts[i * 2 + 2]!, y1 = pts[i * 2 + 3]!;
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    // Sample a couple of points along the quadratic through midpoints.
    const px = pts[(i - 1) * 2]!, py = pts[(i - 1) * 2 + 1]!;
    const pmx = (px + x0) / 2, pmy = (py + y0) / 2;
    [0.4, 0.8].forEach(t => {
      out.push((1 - t) * (1 - t) * pmx + 2 * (1 - t) * t * x0 + t * t * mx,
        (1 - t) * (1 - t) * pmy + 2 * (1 - t) * t * y0 + t * t * my);
    });
  }
  out.push(pts[pts.length - 2]!, pts[pts.length - 1]!);
  return out;
}
