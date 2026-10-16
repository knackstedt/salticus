// ============================================================================
// wb/model.ts — whiteboard canvas content. Persisted per page as
// {type:"whiteboard", wb: WbContent}. Items live in world coordinates;
// the camera pans/zooms over the infinite canvas.
// ============================================================================

import { newId } from "../app/store";

export type WbItemKind = "stroke" | "rect" | "ellipse" | "line" | "text" | "sticky";

export interface WbItem {
  id: string;
  kind: WbItemKind;
  /** World-space origin. */
  x: number;
  y: number;
  /** rect/ellipse/line: extent to x+w,y+h · sticky/text: box size. */
  w: number;
  h: number;
  /** stroke: flattened world-space polyline [x0,y0,x1,y1,...]. */
  points?: number[];
  /** Palette index into WB_COLORS. */
  color: number;
  /** Stroke width (px at zoom 1) or font size for text/sticky. */
  size: number;
  text?: string;
}

export interface WbCamera {
  x: number;
  y: number;
  zoom: number;
}

export interface WbContent {
  items: WbItem[];
  cam: WbCamera;
}

export function newWbItem(kind: WbItemKind, x: number, y: number, color: number, size: number): WbItem {
  return { id: newId("wb"), kind, x, y, w: 0, h: 0, color, size };
}

export function emptyWhiteboard(): WbContent {
  return { items: [], cam: { x: 0, y: 0, zoom: 1 } };
}

export function demoWhiteboard(): WbContent {
  return {
    cam: { x: 0, y: 0, zoom: 1 },
    items: [
      { id: newId("wb"), kind: "sticky", x: 60, y: 60, w: 190, h: 190, color: 3, size: 13,
        text: "Ideas\n\n— GPU-rendered canvas\n— infinite pan/zoom" },
      { id: newId("wb"), kind: "rect", x: 300, y: 80, w: 220, h: 120, color: 0, size: 2 },
      { id: newId("wb"), kind: "text", x: 300, y: 215, w: 0, h: 0, color: 0, size: 18,
        text: "Shapes, strokes, stickies" },
      { id: newId("wb"), kind: "ellipse", x: 560, y: 90, w: 150, h: 110, color: 1, size: 2 },
      { id: newId("wb"), kind: "line", x: 300, y: 260, w: 400, h: 0, color: 2, size: 2 },
    ],
  };
}
