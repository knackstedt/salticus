// ============================================================================
// wb/model.ts — whiteboard canvas content. Persisted per page as
// {type:"whiteboard", wb: WbContent}. Items live in world coordinates;
// the camera pans/zooms over the infinite canvas.
//
// Item model mirrors Excalidraw: stroke/background colors, fill styles,
// stroke styles, sloppiness, opacity, rotation, arrowheads + bindings,
// groups, and container-bound text.
// ============================================================================

import { newId } from "../app/store";

export type WbItemKind = "stroke" | "rect" | "diamond" | "ellipse" | "line" | "arrow" | "text" | "sticky" | "image";
export type WbFillStyle = "none" | "hachure" | "cross" | "solid";
export type WbStrokeStyle = "solid" | "dashed" | "dotted";
export type WbArrowhead = "none" | "arrow" | "triangle" | "dot";
export type WbFont = "hand" | "inter" | "mono";

/** Fractional anchor inside a bound shape's local frame (0..1). */
export interface WbBinding {
  id: string;
  fx: number;
  fy: number;
}

export interface WbItem {
  id: string;
  kind: WbItemKind;
  /** Frame origin (top-left of the unrotated local AABB), world coords. */
  x: number;
  y: number;
  /** Frame size. For strokes/lines this is the points AABB; for text it is
   *  derived from the measured text unless set by a resize. */
  w: number;
  h: number;
  /** stroke: freehand polyline · line/arrow: vertex list.
   *  All relative to (x, y). */
  points?: number[];
  /** Stroke color — palette index into WB_STROKE_COLORS. */
  color: number;
  /** Background/fill color — palette index; -1 = transparent. */
  fill: number;
  fillStyle: WbFillStyle;
  strokeStyle: WbStrokeStyle;
  /** 0 precise · 1 artist · 2 cartoonist. */
  roughness: number;
  /** Stroke width (px at zoom 1); font size for text/sticky. */
  size: number;
  /** Font size for container-bound text (containers keep their stroke width
   *  in `size`). */
  fontSize?: number;
  /** 0..1. */
  opacity: number;
  /** Rotation about the frame center, radians. */
  angle: number;
  /** Rounded corners / joins. */
  round: boolean;
  /** Free text (text/sticky items). */
  text?: string;
  /** Text centered inside a container shape. */
  boundText?: string;
  font?: WbFont;
  /** Group membership — grouped items select/move as one. */
  group?: string;
  /** Arrowheads on line/arrow endpoints. */
  startArrow?: WbArrowhead;
  endArrow?: WbArrowhead;
  /** Arrow endpoint bindings — keep arrows attached to shapes. */
  bindStart?: WbBinding | null;
  bindEnd?: WbBinding | null;
  /** image items: raster asset id — <workspace>/assets/<id>.png. */
  asset?: string;
  /** Hyperlink — https://… opens externally; [[Title]] or a bare page title
   *  opens a doc page. Followed via Ctrl+click or the context menu. */
  link?: string;
}

export interface WbCamera {
  x: number;
  y: number;
  zoom: number;
}

export interface WbContent {
  /** Format version — 2 = frame-relative points + styled items. */
  v?: number;
  items: WbItem[];
  cam: WbCamera;
  /** Dot grid on/off (default on). */
  grid?: boolean;
}

/** Font size (world px) for an item's text: `fontSize` on containers with
 *  bound text, `size` on text/sticky items. */
export function wbFontSize(it: WbItem): number {
  return it.fontSize ?? (it.kind === "text" || it.kind === "sticky" ? it.size : 20);
}

export function newWbItem(kind: WbItemKind, x: number, y: number, color: number, size: number): WbItem {
  return {
    id: newId("wb"), kind, x, y, w: 0, h: 0,
    color, fill: -1, fillStyle: "hachure", strokeStyle: "solid",
    roughness: 1, size, opacity: 1, angle: 0, round: false,
    startArrow: "none", endArrow: "arrow",
  };
}

export function emptyWhiteboard(): WbContent {
  return { v: 2, items: [], cam: { x: 0, y: 0, zoom: 1 } };
}

const FILL_STYLES: WbFillStyle[] = ["none", "hachure", "cross", "solid"];
const STROKE_STYLES: WbStrokeStyle[] = ["solid", "dashed", "dotted"];
const ARROWHEADS: WbArrowhead[] = ["none", "arrow", "triangle", "dot"];
const FONTS: WbFont[] = ["hand", "inter", "mono"];

/** Normalize an item loaded from disk (or pasted) — fills in fields added
 *  after earlier saves. `legacy` marks v<2 content where stroke points were
 *  stored in absolute world coords (rebased into the local frame here). */
export function normalizeWbItem(raw: Partial<WbItem> & { kind: WbItemKind }, legacy = false): WbItem {
  const it: WbItem = {
    id: raw.id ?? newId("wb"),
    kind: raw.kind,
    x: raw.x ?? 0,
    y: raw.y ?? 0,
    w: raw.w ?? 0,
    h: raw.h ?? 0,
    color: raw.color ?? 0,
    fill: raw.fill ?? (raw.kind === "sticky" ? (raw.color ?? 0) : -1),
    fillStyle: FILL_STYLES.includes(raw.fillStyle as WbFillStyle) ? raw.fillStyle! : "hachure",
    strokeStyle: STROKE_STYLES.includes(raw.strokeStyle as WbStrokeStyle) ? raw.strokeStyle! : "solid",
    roughness: typeof raw.roughness === "number" ? raw.roughness : 1,
    size: raw.size ?? 2,
    opacity: typeof raw.opacity === "number" ? raw.opacity : 1,
    angle: raw.angle ?? 0,
    round: raw.round ?? false,
    text: raw.text,
    boundText: raw.boundText,
    fontSize: raw.fontSize,
    // Stickies used to default to the hand font; they now default to Inter —
    // migrate saved stickies that still carry the old default.
    font: FONTS.includes(raw.font as WbFont)
      ? (raw.kind === "sticky" && raw.font === "hand" ? "inter" : raw.font)
      : undefined,
    group: raw.group,
    startArrow: ARROWHEADS.includes(raw.startArrow as WbArrowhead) ? raw.startArrow : "none",
    endArrow: ARROWHEADS.includes(raw.endArrow as WbArrowhead) ? raw.endArrow : (raw.kind === "arrow" ? "arrow" : "none"),
    bindStart: raw.bindStart ?? null,
    bindEnd: raw.bindEnd ?? null,
    asset: raw.asset,
    link: typeof raw.link === "string" && raw.link ? raw.link : undefined,
  };
  if (raw.points) it.points = raw.points.slice();
  // Legacy saves kept stroke points in absolute world coords. Rebase them
  // into the local frame (x,y = AABB min) so every kind stores frame-relative
  // geometry.
  if (legacy && it.points && it.points.length >= 2 && it.kind === "stroke") {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i + 1 < it.points.length; i += 2) {
      minX = Math.min(minX, it.points[i]!); maxX = Math.max(maxX, it.points[i]!);
      minY = Math.min(minY, it.points[i + 1]!); maxY = Math.max(maxY, it.points[i + 1]!);
    }
    for (let i = 0; i + 1 < it.points.length; i += 2) {
      it.points[i] = it.points[i]! - minX;
      it.points[i + 1] = it.points[i + 1]! - minY;
    }
    it.x = minX; it.y = minY;
    it.w = maxX - minX; it.h = maxY - minY;
  } else if (it.points && it.kind === "stroke") {
    normalizeStroke(it);
  }
  // Lines/arrows authored before multi-point support have only x,y,w,h —
  // synthesize a two-point relative polyline.
  if (!it.points && (it.kind === "line" || it.kind === "arrow")) {
    it.points = [0, 0, it.w, it.h];
    if (it.w < 0) { it.x += it.w; }
    if (it.h < 0) { it.y += it.h; }
    normalizeLinear(it);
  }
  return it;
}

/** Recompute a line/arrow's frame from its relative points (x,y = AABB min). */
export function normalizeLinear(it: WbItem): void {
  const p = it.points ?? [];
  if (p.length < 4) { it.w = 0; it.h = 0; return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < p.length; i += 2) {
    minX = Math.min(minX, p[i]!); maxX = Math.max(maxX, p[i]!);
    minY = Math.min(minY, p[i + 1]!); maxY = Math.max(maxY, p[i + 1]!);
  }
  it.x += minX; it.y += minY;
  for (let i = 0; i + 1 < p.length; i += 2) {
    p[i] = p[i]! - minX;
    p[i + 1] = p[i + 1]! - minY;
  }
  it.w = maxX - minX; it.h = maxY - minY;
}

/** Recompute a stroke's frame from its relative points. */
export function normalizeStroke(it: WbItem): void {
  const p = it.points ?? [];
  if (p.length < 2) { it.w = 0; it.h = 0; return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < p.length; i += 2) {
    minX = Math.min(minX, p[i]!); maxX = Math.max(maxX, p[i]!);
    minY = Math.min(minY, p[i + 1]!); maxY = Math.max(maxY, p[i + 1]!);
  }
  it.w = maxX - minX; it.h = maxY - minY;
}

export function normalizeWbContent(raw: unknown): WbContent {
  const c = raw as Partial<WbContent> | null;
  const legacy = (c?.v ?? 1) < 2;
  return {
    v: 2,
    items: (c?.items ?? []).map((i) => normalizeWbItem(i as WbItem, legacy)),
    cam: c?.cam ? { x: c.cam.x ?? 0, y: c.cam.y ?? 0, zoom: c.cam.zoom ?? 1 } : { x: 0, y: 0, zoom: 1 },
    grid: c?.grid ?? true,
  };
}

export function demoWhiteboard(): WbContent {
  const mk = (kind: WbItemKind, x: number, y: number, w: number, h: number,
    color: number, opts: Partial<WbItem> = {}): WbItem =>
    ({ ...newWbItem(kind, x, y, color, 2), w, h, ...opts });
  const sticky = mk("sticky", 60, 60, 210, 200, 0, {
    fill: 3, size: 13, font: "inter",
    text: "# Whiteboard\n\n- **sketchy** strokes + fills\n- snap, rotate, resize\n- bound arrows + *labels*",
  });
  const card = mk("rect", 330, 80, 240, 130, 0, { fill: 2, fillStyle: "solid", round: true, boundText: "Double-click a shape\nto label it" });
  const orb = mk("ellipse", 620, 80, 160, 120, 1, { fill: 1, fillStyle: "hachure" });
  const gem = mk("diamond", 830, 80, 130, 130, 4, { fillStyle: "cross", fill: 4 });
  const arrow = mk("arrow", 570, 140, 40, 10, 5, { bindStart: { id: card.id, fx: 1, fy: 0.5 }, bindEnd: { id: orb.id, fx: 0, fy: 0.5 } });
  arrow.points = [0, 0, 40, 10];
  const spin = mk("rect", 330, 280, 130, 90, 2, { angle: 0.35, boundText: "rotated" });
  const label = mk("text", 60, 310, 0, 0, 0, { size: 18, font: "hand", text: "select, move, snap — V · drag on empty space pans · ctrl+wheel zooms" });
  return { v: 2, cam: { x: 0, y: 0, zoom: 1 }, items: [sticky, card, orb, gem, arrow, spin, label] };
}
