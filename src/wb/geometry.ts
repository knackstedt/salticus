// ============================================================================
// wb/geometry.ts — pure geometry for the whiteboard: local frames, rotation,
// hit tests, arrow-binding resolution, outline intersection, and alignment
// snapping. Items store an unrotated local frame (x,y,w,h) + `angle` about
// the frame center; everything here bridges local ↔ world space.
// ============================================================================

import type { WbItem } from "./model";

export interface Frame { x: number; y: number; w: number; h: number }
export interface Pt { x: number; y: number }

/** Text measurement callback — advance width of `text` in `font` at `size`. */
export type MeasureFn = (font: string | undefined, size: number, text: string) => number;

export const LINE_H = 1.25; // line height as a multiple of font size

export function faceFor(font: string | undefined, weight = 400, italic = false): string {
  if (font === "mono") return `jetbrains:${weight}:${italic ? "italic" : "normal"}`;
  // Caveat ships no italic — slant would need a fake transform; keep normal.
  if (font === "hand") return `hand:${weight}:normal`;
  return `inter:${weight}:${italic ? "italic" : "normal"}`;
}

// ── basics ──────────────────────────────────────────────────────────────────

export function rot(x: number, y: number, cx: number, cy: number, a: number): Pt {
  const s = Math.sin(a), c = Math.cos(a);
  const dx = x - cx, dy = y - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

export function unrot(x: number, y: number, cx: number, cy: number, a: number): Pt {
  return rot(x, y, cx, cy, -a);
}

export function frameCenter(f: Frame): Pt {
  return { x: f.x + f.w / 2, y: f.y + f.h / 2 };
}

export function distToSeg(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
  return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
}

// ── frames ──────────────────────────────────────────────────────────────────

/** Word-wrap `text` to `maxW` px; returns the wrapped lines. */
export function wrapText(text: string, font: string | undefined, size: number, maxW: number, measure: MeasureFn): string[] {
  const out: string[] = [];
  text.split("\n").forEach(raw => {
    if (!raw) { out.push(""); return; }
    let line = "";
    raw.split(" ").forEach(word => {
      const cand = line ? line + " " + word : word;
      if (line && measure(font, size, cand) > maxW) {
        out.push(line);
        line = word;
      } else {
        line = cand;
      }
    });
    out.push(line);
  });
  return out;
}

/** Measured frame of a text item (unwrapped multi-line). */
export function textFrame(it: WbItem, measure: MeasureFn): Frame {
  const lines = (it.text ?? "").split("\n");
  let w = 4;
  lines.forEach(l => { w = Math.max(w, measure(it.font, it.size, l) + 2); });
  return { x: it.x, y: it.y, w, h: Math.max(1, lines.length) * it.size * LINE_H };
}

/** Local (unrotated) frame of any item, world coords. */
export function frameOf(it: WbItem, measure: MeasureFn): Frame {
  if (it.kind === "text") {
    // Text frames always track the measured glyph box — Excalidraw text has
    // no explicit resize, so stored dims are just a cache of the last measure.
    const f = textFrame(it, measure);
    it.w = f.w; it.h = f.h;
    return f;
  }
  return { x: it.x, y: it.y, w: it.w, h: it.h };
}

/** Axis-aligned world bounds of a rotated item. */
export function worldAABB(it: WbItem, measure: MeasureFn): Frame {
  const f = frameOf(it, measure);
  if (!it.angle) return f;
  const c = frameCenter(f);
  const cs = [
    rot(f.x, f.y, c.x, c.y, it.angle),
    rot(f.x + f.w, f.y, c.x, c.y, it.angle),
    rot(f.x + f.w, f.y + f.h, c.x, c.y, it.angle),
    rot(f.x, f.y + f.h, c.x, c.y, it.angle),
  ];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  cs.forEach(p => {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  });
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function combineAABBs(frames: Frame[]): Frame {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  frames.forEach(f => {
    minX = Math.min(minX, f.x); maxX = Math.max(maxX, f.x + f.w);
    minY = Math.min(minY, f.y); maxY = Math.max(maxY, f.y + f.h);
  });
  if (!isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// ── arrow binding ───────────────────────────────────────────────────────────

/** World position a binding anchors to on its host shape. */
export function bindingAnchorWorld(bind: { id: string; fx: number; fy: number },
  items: WbItem[], measure: MeasureFn): Pt | null {
  const host = items.find((i) => i.id === bind.id);
  if (!host) return null;
  const f = frameOf(host, measure);
  const c = frameCenter(f);
  const lx = f.x + bind.fx * f.w, ly = f.y + bind.fy * f.h;
  return host.angle ? rot(lx, ly, c.x, c.y, host.angle) : { x: lx, y: ly };
}

/** Intersect segment a→b with a shape outline (bound-item local coords; b is
 *  typically inside). Returns the crossing point nearest a. */
function outlineHit(it: WbItem, f: Frame, a: Pt, b: Pt): Pt | null {
  const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
  const rx = Math.max(f.w / 2, 0.001), ry = Math.max(f.h / 2, 0.001);
  // Normalized inside-test per shape kind: >0 outside, ≤0 inside.
  const inside = (p: Pt): number => {
    if (it.kind === "ellipse") {
      const u = (p.x - cx) / rx, v = (p.y - cy) / ry;
      return u * u + v * v - 1;
    }
    if (it.kind === "diamond") {
      return Math.abs((p.x - cx) / rx) + Math.abs((p.y - cy) / ry) - 1;
    }
    // rect + fallbacks: box test
    const u = Math.abs((p.x - cx) / rx) - 1, v = Math.abs((p.y - cy) / ry) - 1;
    return Math.max(u, v);
  };
  if (inside(a) <= 0) return a; // already inside — nothing to clip to
  // Bisection on t ∈ [0,1]: f(a)>0 (outside), f(b)≤0 (inside).
  let lo = 0, hi = 1;
  for (let i = 0; i < 28; i++) {
    const t = (lo + hi) / 2;
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    if (inside(p) > 0) lo = t; else hi = t;
  }
  const t = hi;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Resolve one bound endpoint to a world-space point on the host outline,
 *  approached along the segment from `from` (world, unrotated local space). */
function boundEdgeWorld(bind: { id: string; fx: number; fy: number }, from: Pt,
  items: WbItem[], measure: MeasureFn): Pt | null {
  const host = items.find((i) => i.id === bind.id);
  if (!host) return null;
  const anchor = bindingAnchorWorld(bind, items, measure);
  if (!anchor) return null;
  const f = frameOf(host, measure);
  const c = frameCenter(f);
  // Segment in host-local space.
  const aL = host.angle ? unrot(from.x, from.y, c.x, c.y, host.angle) : from;
  const bL = host.angle ? unrot(anchor.x, anchor.y, c.x, c.y, host.angle) : anchor;
  const hit = outlineHit(host, f, aL, bL);
  if (!hit) return anchor;
  const w = host.angle ? rot(hit.x, hit.y, c.x, c.y, host.angle) : hit;
  // Small gap so the line stops just short of the edge. Anchor may already sit
  // on the outline (edge-fraction ports) — skip the gap when it does.
  const dx = anchor.x - w.x, dy = anchor.y - w.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return w;
  const gap = Math.min(6, len);
  return { x: w.x + (dx / len) * gap, y: w.y + (dy / len) * gap };
}

/** Absolute (unrotated) world-space polyline for point-based items, with
 *  bound endpoints resolved against their hosts. */
export function resolvedPoints(it: WbItem, items: WbItem[], measure: MeasureFn): number[] {
  const p = it.points ?? [];
  const out: number[] = [];
  for (let i = 0; i + 1 < p.length; i += 2) out.push(it.x + p[i]!, it.y + p[i + 1]!);
  if ((it.kind === "line" || it.kind === "arrow") && out.length >= 4) {
    const f = frameOf(it, measure);
    const c = frameCenter(f);
    const toWorld = (lx: number, ly: number): Pt =>
      it.angle ? rot(lx, ly, c.x, c.y, it.angle) : { x: lx, y: ly };
    const toLocal = (w: Pt): Pt =>
      it.angle ? unrot(w.x, w.y, c.x, c.y, it.angle) : w;
    if (it.bindEnd) {
      const prev = toWorld(it.x + p[p.length - 4]!, it.y + p[p.length - 3]!);
      const edge = boundEdgeWorld(it.bindEnd, prev, items, measure);
      if (edge) {
        const l = toLocal(edge);
        out[out.length - 2] = l.x; out[out.length - 1] = l.y;
      }
    }
    if (it.bindStart) {
      const next = toWorld(it.x + p[2]!, it.y + p[3]!);
      const edge = boundEdgeWorld(it.bindStart, next, items, measure);
      if (edge) {
        const l = toLocal(edge);
        out[0] = l.x; out[1] = l.y;
      }
    }
  }
  return out;
}

// ── hit testing ─────────────────────────────────────────────────────────────

/** Point-in-item test (tolerance in world px). */
export function hitItem(it: WbItem, wx: number, wy: number, tol: number,
  measure: MeasureFn, items: WbItem[]): boolean {
  const f = frameOf(it, measure);
  const c = frameCenter(f);
  const p = it.angle ? unrot(wx, wy, c.x, c.y, it.angle) : { x: wx, y: wy };
  switch (it.kind) {
    case "stroke": {
      const pts = resolvedPoints(it, items, measure);
      for (let i = 0; i + 3 < pts.length; i += 2) {
        if (distToSeg(p.x, p.y, pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!) < tol + it.size) return true;
      }
      return pts.length === 2 && Math.hypot(p.x - pts[0]!, p.y - pts[1]!) < tol + it.size;
    }
    case "line":
    case "arrow": {
      const pts = resolvedPoints(it, items, measure);
      for (let i = 0; i + 3 < pts.length; i += 2) {
        if (distToSeg(p.x, p.y, pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!) < tol + it.size) return true;
      }
      return false;
    }
    case "ellipse": {
      const rx = Math.max(f.w / 2, 0.001), ry = Math.max(f.h / 2, 0.001);
      const u = (p.x - c.x) / rx, v = (p.y - c.y) / ry;
      const d = u * u + v * v;
      // Hit the fill when inside; hit near the outline otherwise (either side).
      if (it.fill >= 0) return d <= 1;
      return Math.abs(Math.sqrt(d) - 1) * Math.min(rx, ry) <= tol + it.size;
    }
    case "diamond": {
      const rx = Math.max(f.w / 2, 0.001), ry = Math.max(f.h / 2, 0.001);
      const d = Math.abs((p.x - c.x) / rx) + Math.abs((p.y - c.y) / ry);
      if (it.fill >= 0) return d <= 1;
      return Math.abs(d - 1) * Math.min(rx, ry) <= tol + it.size;
    }
    case "rect": {
      if (it.fill >= 0 || p.x < f.x || p.x > f.x + f.w || p.y < f.y || p.y > f.y + f.h) {
        return p.x >= f.x - tol && p.x <= f.x + f.w + tol && p.y >= f.y - tol && p.y <= f.y + f.h + tol;
      }
      // Unfilled rect hits only near the outline.
      const edge = Math.min(p.x - f.x, f.x + f.w - p.x, p.y - f.y, f.y + f.h - p.y);
      return edge <= tol + it.size;
    }
    default:
      return p.x >= f.x - tol && p.x <= f.x + f.w + tol && p.y >= f.y - tol && p.y <= f.y + f.h + tol;
  }
}

/** Segments of an item for eraser intersection — local (unrotated) world pts. */
export function itemSegments(it: WbItem, items: WbItem[], measure: MeasureFn): number[] {
  if (it.kind === "stroke" || it.kind === "line" || it.kind === "arrow") {
    return resolvedPoints(it, items, measure);
  }
  const f = frameOf(it, measure);
  if (it.kind === "ellipse") {
    const out: number[] = [];
    const n = 32;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      out.push(f.x + f.w / 2 + Math.cos(a) * f.w / 2, f.y + f.h / 2 + Math.sin(a) * f.h / 2);
    }
    return out;
  }
  if (it.kind === "diamond") {
    const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
    return [cx, f.y, f.x + f.w, cy, cx, f.y + f.h, f.x, cy, cx, f.y];
  }
  return [f.x, f.y, f.x + f.w, f.y, f.x + f.w, f.y + f.h, f.x, f.y + f.h, f.x, f.y];
}

/** Eraser touch: segment within `r` of the point, or inside a filled shape. */
export function eraserHits(it: WbItem, wx: number, wy: number, r: number,
  measure: MeasureFn, items: WbItem[]): boolean {
  const f = frameOf(it, measure);
  const c = frameCenter(f);
  const p = it.angle ? unrot(wx, wy, c.x, c.y, it.angle) : { x: wx, y: wy };
  if ((it.kind === "rect" || it.kind === "sticky" || it.kind === "text" || it.kind === "image") &&
      p.x >= f.x && p.x <= f.x + f.w && p.y >= f.y && p.y <= f.y + f.h) return true;
  if ((it.kind === "ellipse" || it.kind === "diamond") && it.fill >= 0 &&
      hitItem(it, wx, wy, 0, measure, items)) return true;
  const seg = itemSegments(it, items, measure);
  for (let i = 0; i + 3 < seg.length; i += 2) {
    if (distToSeg(p.x, p.y, seg[i]!, seg[i + 1]!, seg[i + 2]!, seg[i + 3]!) < r + it.size / 2) return true;
  }
  return false;
}

// ── snapping ────────────────────────────────────────────────────────────────

export interface Snap {
  dx: number;
  dy: number;
  /** Guide lines to draw: world x for a vertical guide, world y for horizontal. */
  gx: number | null;
  gy: number | null;
}

/** Snap a dragged AABB to edges/centers of `others` within `tol` world px. */
export function snapDelta(drag: Frame, others: Frame[], tol: number): Snap {
  const xs = (f: Frame): number[] => [f.x, f.x + f.w / 2, f.x + f.w];
  const ys = (f: Frame): number[] => [f.y, f.y + f.h / 2, f.y + f.h];
  const dragX = xs(drag), dragY = ys(drag);
  let bestX = { d: tol, v: 0, g: null as number | null };
  let bestY = { d: tol, v: 0, g: null as number | null };
  others.forEach(f => {
    xs(f).forEach(c => dragX.forEach(d => {
      const delta = c - d;
      if (Math.abs(delta) < bestX.d) bestX = { d: Math.abs(delta), v: delta, g: c };
    }));
    ys(f).forEach(c => dragY.forEach(d => {
      const delta = c - d;
      if (Math.abs(delta) < bestY.d) bestY = { d: Math.abs(delta), v: delta, g: c };
    }));
  });
  return {
    dx: bestX.g !== null ? bestX.v : 0,
    dy: bestY.g !== null ? bestY.v : 0,
    gx: bestX.g, gy: bestY.g,
  };
}
