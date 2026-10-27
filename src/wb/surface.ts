// ============================================================================
// wb/surface.ts — infinite-canvas whiteboard, custom GPU surface.
//
// Excalidraw-class feature set:
//   tools: select, hand, pen, rect, diamond, ellipse, arrow, line, text,
//          sticky, eraser — with a lock toggle and one-shot tool return
//   selection: click, shift-click, marquee; groups act as one
//   manipulation: move (with snap guides), 8-handle resize, rotate, nudge
//   editing: bound labels on shapes, full caret/selection text editing
//   style: stroke/bg colors, solid/hachure/cross fills, dashed/dotted,
//          sloppiness, rounded edges, opacity — via the left props panel
//   lines/arrows: multi-point click-drawn segments, arrowheads both ends,
//          endpoint binding to shapes that tracks on move
//   history/clipboard: undo/redo, copy/cut/paste/duplicate, z-order
//   canvas: dot grid toggle, pan/zoom, zoom-to-fit, right-click menu
// ============================================================================

import type { ScreenUiCompositor, RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import { GpuTextPass, type Rgba } from "../text/gpu-text";
import { RunCache } from "../text/run-cache";
import { TextAtlas } from "../text/atlas";
import { tokens } from "../app/theme";
import { newId, store } from "../app/store";
import {
  emptyWhiteboard, newWbItem, normalizeLinear, normalizeStroke, normalizeWbContent,
  wbFontSize,
  type WbArrowhead, type WbContent, type WbItem, type WbItemKind,
} from "./model";
import {
  combineAABBs, frameOf, frameCenter, hitItem, eraserHits,
  resolvedPoints, rot, snapDelta, textFrame, unrot, faceFor, LINE_H,
  type Frame,
} from "./geometry";
import {
  WbPainter, STROKE_COLORS, FILL_COLORS, hex, withAlpha, textLayout,
} from "./draw";
import { wbSvg, wbBounds } from "./svg";
import { cropRgba, pdfFromRgba } from "./raster";
import { encodePNG } from "@downdraft/platform-native";
import { getNativeHost } from "@downdraft/engine";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspaceDir } from "../app/workspace";

// ── constants ────────────────────────────────────────────────────────────────

type Tool = "select" | "hand" | "pen" | "rect" | "diamond" | "ellipse" | "arrow" | "line" | "text" | "sticky" | "eraser";

const TOOLS: { id: Tool; num: string }[] = [
  { id: "select", num: "1" },
  { id: "hand", num: "2" },
  { id: "rect", num: "3" },
  { id: "diamond", num: "4" },
  { id: "ellipse", num: "5" },
  { id: "arrow", num: "6" },
  { id: "line", num: "7" },
  { id: "pen", num: "8" },
  { id: "text", num: "9" },
  { id: "sticky", num: "0" },
  { id: "eraser", num: "-" },
];

const TOOL_TIPS: Record<string, string> = {
  lock: "Lock tool",
  select: "Select (V)", hand: "Pan (H)", rect: "Rectangle (R)",
  diamond: "Diamond (D)", ellipse: "Ellipse (O)", arrow: "Arrow (A)",
  line: "Line (L)", pen: "Pen (P)", text: "Text (T)", sticky: "Sticky note (S)",
  eraser: "Eraser (E)", undo: "Undo (Ctrl+Z)", redo: "Redo (Ctrl+Shift+Z)",
  grid: "Toggle grid", zout: "Zoom out", zin: "Zoom in",
  zlabel: "Reset zoom", zfit: "Zoom to fit",
};

const STROKE_WIDTHS = [1.5, 2.5, 4];
const FONT_SIZES = [15, 20, 28, 38];
const CLOSED_KINDS: WbItemKind[] = ["rect", "diamond", "ellipse", "sticky"];
const LINEAR_KINDS: WbItemKind[] = ["line", "arrow"];

// ── drafts / edits ───────────────────────────────────────────────────────────

interface DraftState {
  kind: "pen" | "shape" | "linear" | "move" | "resize" | "rotate" | "marquee" | "pan" | "erase" | "slider" | "vertex";
  item?: WbItem;
  items0?: WbItem[];            // pre-drag snapshot (undo)
  startWX: number; startWY: number;
  sx0: number; sy0: number;
  moved: boolean;
  camStart?: { x: number; y: number };
  handle?: string;              // resize handle id
  resizeItems?: { it: WbItem; f: Frame }[];
  box0?: Frame;                 // pre-drag selection box (resize/rotate)
  angle0?: number;              // pointer angle at rotate start
  itemsAngle0?: number[];       // per-item angles for multi-rotate
  marqueeAdd?: boolean;
  eraseSet?: Set<string>;
  linearDragged?: boolean;
  vIdx?: number;                // dragged vertex index (vertex drafts)
  sliderId?: string;
  shift0?: boolean;
  moveBase?: Map<string, { x: number; y: number }>;
}

interface WbEdit {
  itemId: string;
  field: "text" | "boundText";
  caret: number;
  anchor: number;
  isNew: boolean;
  orig: string;
  snapshot: WbItem[];
}

interface MenuEntry {
  label: string;
  key?: string;
  enabled: boolean;
  action: () => void;
}

interface UiRect { x: number; y: number; w: number; h: number }

// ── surface ──────────────────────────────────────────────────────────────────

export class WhiteboardSurface implements ScreenUiCompositor {
  order = -10;
  private pass: GpuTextPass;
  private cache: RunCache;
  private atlas: TextAtlas;
  private rect = { x: 0, y: 0, w: 0, h: 0 };
  private wb: WbContent = emptyWhiteboard();
  private unsubs: (() => void)[] = [];
  private disposed = false;
  private active = false;

  private tool: Tool = "select";
  private toolLocked = false;
  private selected = new Set<string>();
  private draft: DraftState | null = null;
  private editing: WbEdit | null = null;
  private undoStack: WbItem[][] = [];
  private redoStack: WbItem[][] = [];
  private clipboard: WbItem[] = [];
  private spaceHeld = false;
  private menu: { x: number; y: number; entries: (MenuEntry | "sep")[]; hover: number } | null = null;
  private snapGuide: { gx: number | null; gy: number | null } | null = null;
  private cursor = { x: 0, y: 0 };
  private lastClick = { t: 0, x: 0, y: 0 };
  private pointerHeld = false;
  /** Deferred double-click: set on a select-tool pointerdown that lands within
   *  the dbl window; consumed on pointerup only if the press never dragged —
   *  so a quick click-then-drag always moves/marquees instead of editing. */
  private pendingDbl: { wx: number; wy: number } | null = null;
  private blinkT = 0;
  private time = 0;
  private lastTickMs = 0;
  private pendingChars: { ch: string; t: number }[] = [];
  /** While exporting: suppress chrome (toolbar/panels/selection/ports/grid)
   *  so a captured frame contains only the board contents. */
  private exportClean = false;
  private toast: { text: string; t: number } | null = null;
  /** Engine damage-gate mark for mutations that don't ride a store/input
   *  wake — set in dirty() and the setters below. */
  private framePending = true;
  private blinkPhase = -1;
  private lastAnim = false;

  /** Defaults applied to newly drawn items (updated by the props panel). */
  private style = {
    color: 0, fill: -1, fillStyle: "hachure" as WbItem["fillStyle"],
    strokeStyle: "solid" as WbItem["strokeStyle"], roughness: 1,
    round: false, size: 2.5, fontSize: 20, opacity: 1,
    font: "hand" as WbItem["font"], endArrow: "arrow" as WbArrowhead,
  };

  // Clickable UI regions rebuilt per frame.
  private toolRects: { id: string; r: UiRect }[] = [];
  private propRects: { id: string; value: string; r: UiRect }[] = [];
  private zoomRects: { id: string; r: UiRect }[] = [];
  private menuRect: UiRect | null = null;
  private panelRect: UiRect | null = null;
  private handleRects: { id: string; x: number; y: number }[] = [];
  private toolbarRect: UiRect | null = null;

  onChange: ((c: WbContent) => void) | null = null;

  constructor(private ctx: RendererModuleContext, sharedCache?: RunCache) {
    const device = ctx.getDevice();
    this.pass = new GpuTextPass(device, ctx.getFormat());
    this.cache = sharedCache ?? new RunCache(new TextAtlas(device, 2048));
    this.atlas = this.cache.atlas;
    this.installInput();
  }

  setActive(a: boolean): void {
    if (this.active === a) return;
    this.active = a;
    if (!a) {
      this.commitEdit();
      this.draft = null;
      this.menu = null;
    }
    this.framePending = true;
  }

  /** Buffer px per logical px — set by setRect; converts input + projection. */
  private dpr = 1;

  setRect(r: { x: number; y: number; w: number; h: number }, dpr = 1): void {
    this.dpr = dpr;
    // All surface math is logical px; the caller's rect is buffer px.
    this.rect = { x: r.x / dpr, y: r.y / dpr, w: r.w / dpr, h: r.h / dpr };
    this.framePending = true;
  }

  /** Input events arrive in buffer px — convert to this surface's logical px. */
  private loc<E extends object>(e: E): E {
    const d = this.dpr;
    if (d === 1) return e;
    const c = { ...(e as Record<string, unknown>) };
    ["clientX", "clientY", "deltaX", "deltaY", "dx", "dy"].forEach((k) => {
      if (typeof c[k] === "number") c[k] = (c[k] as number) / d;
    });
    return c as E;
  }

  setContent(c: WbContent | null): void {
    this.wb = normalizeWbContent(c) ?? emptyWhiteboard();
    this.editing = null;
    this.draft = null;
    this.menu = null;
    this.selected.clear();
    this.undoStack = [];
    this.redoStack = [];
  }

  getContent(): WbContent {
    return this.wb;
  }

  /** Introspection for the MCP harness. */
  debugState(): Record<string, unknown> {
    return {
      items: this.wb.items.length,
      kinds: this.wb.items.map((i) => i.kind),
      detail: this.wb.items.map((i) => ({
        id: i.id, kind: i.kind,
        x: Math.round(i.x), y: Math.round(i.y),
        w: Math.round(i.w), h: Math.round(i.h),
        angle: +i.angle.toFixed(3),
        fill: i.fill, fillStyle: i.fillStyle, strokeStyle: i.strokeStyle,
        roughness: i.roughness, opacity: i.opacity, size: i.size,
        startArrow: i.startArrow, endArrow: i.endArrow,
        font: i.font, fontSize: i.fontSize, nPoints: i.points ? i.points.length / 2 : undefined,
        text: i.text, boundText: i.boundText, group: i.group,
        bindStart: i.bindStart, bindEnd: i.bindEnd,
      })),
      cam: this.wb.cam,
      tool: this.tool,
      draft: this.draft?.kind ?? null,
      handles: this.handleRects.map((h) => ({ id: h.id, x: Math.round(h.x), y: Math.round(h.y) })),
      vertexHandles: this.vertexHandles().map((v) => ({ idx: v.idx, x: Math.round(v.x), y: Math.round(v.y), mid: v.mid })),
      ports: (() => {
        const host = this.portHostAtCursor();
        return host ? this.portsOf(host).map((p) => ({ x: Math.round(this.w2sX(p.x)), y: Math.round(this.w2sY(p.y)) })) : [];
      })(),
      selected: [...this.selected],
      editing: this.editing ? { itemId: this.editing.itemId, field: this.editing.field } : null,
      undoDepth: this.undoStack.length,
      redoDepth: this.redoStack.length,
      grid: this.wbGrid,
    };
  }

  private dirty(): void {
    this.framePending = true;
    this.onChange?.(this.wb);
  }

  // ── transforms ────────────────────────────────────────────────────────────

  private w2sX(wx: number): number {
    return this.rect.x + (wx - this.wb.cam.x) * this.wb.cam.zoom;
  }
  private w2sY(wy: number): number {
    return this.rect.y + (wy - this.wb.cam.y) * this.wb.cam.zoom;
  }
  private s2wX(sx: number): number {
    return (sx - this.rect.x) / this.wb.cam.zoom + this.wb.cam.x;
  }
  private s2wY(sy: number): number {
    return (sy - this.rect.y) / this.wb.cam.zoom + this.wb.cam.y;
  }
  private painter(): WbPainter {
    return new WbPainter({
      pass: this.pass, cache: this.cache, atlas: this.atlas,
      theme: tokens(store.getState().theme),
      w2sX: (x) => this.w2sX(x), w2sY: (y) => this.w2sY(y), zoom: this.wb.cam.zoom,
    });
  }
  private get measure() {
    const p = this.painter();
    return p.measure;
  }
  private get wbGrid(): boolean {
    return this.wb.grid !== false;
  }

  // ── history ────────────────────────────────────────────────────────────────

  private cloneItems(): WbItem[] {
    return JSON.parse(JSON.stringify(this.wb.items)) as WbItem[];
  }

  /** Push a snapshot of the CURRENT items before mutating. Pass an explicit
   *  pre-state when the mutation already happened over a drag. */
  private pushUndo(pre?: WbItem[]): void {
    this.undoStack.push(pre ? JSON.parse(JSON.stringify(pre)) as WbItem[] : this.cloneItems());
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  private undo(): void {
    this.commitEdit();
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.cloneItems());
    this.wb.items = s;
    this.pruneSelection();
    this.dirty();
  }

  private redo(): void {
    this.commitEdit();
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.cloneItems());
    this.wb.items = s;
    this.pruneSelection();
    this.dirty();
  }

  // ── selection helpers ───────────────────────────────────────────────────────

  private pruneSelection(): void {
    const ids = new Set(this.wb.items.map((i) => i.id));
    this.selected.forEach(id => { if (!ids.has(id)) this.selected.delete(id); });
  }

  /** Selected items, expanded to include group-mates. */
  private selectionItems(): WbItem[] {
    if (this.selected.size === 0) return [];
    const groups = new Set<string>();
    this.wb.items.forEach(it => { if (this.selected.has(it.id) && it.group) groups.add(it.group!); });
    return this.wb.items.filter((i) => this.selected.has(i.id) || (i.group && groups.has(i.group)));
  }

  private hitAt(wx: number, wy: number, tol = 6): WbItem | null {
    for (let i = this.wb.items.length - 1; i >= 0; i--) {
      const it = this.wb.items[i]!;
      if (hitItem(it, wx, wy, tol / this.wb.cam.zoom, this.measure, this.wb.items)) return it;
    }
    return null;
  }

  /** Geometric interior test for bindable containers — used by double-click
   *  text binding, where Excalidraw binds even inside unfilled shapes that a
   *  stroke-hit would miss. */
  private containerAt(wx: number, wy: number): WbItem | null {
    for (let i = this.wb.items.length - 1; i >= 0; i--) {
      const it = this.wb.items[i]!;
      if (it.kind !== "rect" && it.kind !== "ellipse" && it.kind !== "diamond") continue;
      const f = frameOf(it, this.measure);
      const c = frameCenter(f);
      const p = it.angle ? unrot(wx, wy, c.x, c.y, it.angle) : { x: wx, y: wy };
      if (it.kind === "ellipse") {
        const nx = (p.x - c.x) / Math.max(1, f.w / 2), ny = (p.y - c.y) / Math.max(1, f.h / 2);
        if (nx * nx + ny * ny <= 1) return it;
      } else if (p.x >= f.x && p.x <= f.x + f.w && p.y >= f.y && p.y <= f.y + f.h) return it;
    }
    return null;
  }

  /** Selection box: single item → its (possibly rotated) frame; multi →
   *  combined axis-aligned bounds. */
  private selectionBox(): { f: Frame; angle: number } | null {
    const sel = this.selectionItems();
    if (sel.length === 0) return null;
    if (sel.length === 1) return { f: this.localFrame(sel[0]!), angle: sel[0]!.angle };
    // Multi-select box is axis-aligned — aabbOf already resolves bound
    // connector endpoints and applies rotation.
    return { f: combineAABBs(sel.map((i) => this.aabbOf(i))), angle: 0 };
  }

  // ── input ──────────────────────────────────────────────────────────────────

  private installInput(): void {
    const bus = this.ctx.getInputBus();
    const inCanvas = (x: number, y: number) =>
      this.active && x >= this.rect.x && y >= this.rect.y &&
      x <= this.rect.x + this.rect.w && y <= this.rect.y + this.rect.h;
    const hit = (r: UiRect | null, x: number, y: number) =>
      !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

    this.unsubs.push(bus.onPointerDown((e, ctrl) => {
      e = this.loc(e);
      this.pointerHeld = true;
      if (!this.active) return;
      if (!inCanvas(e.clientX, e.clientY)) return;

      // Context menu first — clicks inside pick an entry, outside dismiss.
      if (this.menu) {
        ctrl.stopPropagation();
        const m = this.menu;
        if (hit(this.menuRect, e.clientX, e.clientY)) {
          const idx = this.menuIndexAt(e.clientY);
          const ent = idx >= 0 ? m.entries[idx] : null;
          if (ent && ent !== "sep" && ent.enabled) ent.action();
        }
        this.menu = null;
        return;
      }

      // Floating UI islands.
      if (hit(this.toolbarRect, e.clientX, e.clientY)) {
        ctrl.stopPropagation();
        const t = this.toolRects.find(t => hit(t.r, e.clientX, e.clientY));
        if (t) this.onToolbarClick(t.id);
        return;
      }
      if (this.panelRect && hit(this.panelRect, e.clientX, e.clientY)) {
        ctrl.stopPropagation();
        const pr = this.propRects.find(pr => hit(pr.r, e.clientX, e.clientY));
        if (pr) this.onPropClick(pr.id, pr.value, pr.r, e.clientX);
        return;
      }
      const zr = this.zoomRects.find(zr => hit(zr.r, e.clientX, e.clientY));
      if (zr) {
        ctrl.stopPropagation();
        this.onZoomClick(zr.id);
        return;
      }

      // Editing session — click away commits; click inside keeps editing.
      if (this.editing) {
        const it = this.wb.items.find((i) => i.id === this.editing!.itemId);
        const wx0 = this.s2wX(e.clientX), wy0 = this.s2wY(e.clientY);
        let inside = false;
        if (it && e.button === 0) {
          if (this.editing!.field === "boundText") {
            const f = frameOf(it, this.measure);
            const c = frameCenter(f);
            const p = it.angle ? unrot(wx0, wy0, c.x, c.y, it.angle) : { x: wx0, y: wy0 };
            inside = p.x >= f.x - 8 && p.x <= f.x + f.w + 8 && p.y >= f.y - 8 && p.y <= f.y + f.h + 8;
          } else {
            inside = hitItem(it, wx0, wy0, 8 / this.wb.cam.zoom, this.measure, this.wb.items);
          }
        }
        if (inside) {
          this.clickToCaret(it!, e.clientX, e.clientY, e.shiftKey);
          ctrl.stopPropagation();
          return;
        }
        this.commitEdit();
      }

      const wx = this.s2wX(e.clientX);
      const wy = this.s2wY(e.clientY);
      const z = this.wb.cam.zoom;

      // Middle button always pans; right button opens the context menu.
      if (e.button === 1 || this.spaceHeld || this.tool === "hand") {
        if (e.button !== 2) {
          ctrl.stopPropagation();
          this.draft = { kind: "pan", startWX: wx, startWY: wy, sx0: e.clientX, sy0: e.clientY, moved: false, camStart: { x: this.wb.cam.x, y: this.wb.cam.y } };
          return;
        }
      }
      if (e.button === 2) {
        ctrl.stopPropagation();
        this.openMenu(e.clientX, e.clientY, wx, wy);
        return;
      }

      ctrl.stopPropagation();
      // Double-click detection.
      const now = performance.now();
      const dbl = now - this.lastClick.t < 400 && Math.hypot(e.clientX - this.lastClick.x, e.clientY - this.lastClick.y) < 8;
      this.lastClick = { t: now, x: e.clientX, y: e.clientY };
      this.pendingDbl = null;
      if (dbl && this.draft?.kind === "linear") { this.finishLinear(); return; }

      switch (this.tool) {
        case "pen": {
          const item = this.newItem("stroke", wx, wy);
          item.points = [0, 0];
          this.draft = { kind: "pen", item, startWX: wx, startWY: wy, sx0: e.clientX, sy0: e.clientY, moved: false };
          break;
        }
        case "rect":
        case "diamond":
        case "ellipse": {
          const item = this.newItem(this.tool, wx, wy);
          this.draft = { kind: "shape", item, startWX: wx, startWY: wy, sx0: e.clientX, sy0: e.clientY, moved: false, shift0: e.shiftKey };
          break;
        }
        case "arrow":
        case "line": {
          // Connection port under the cursor → drag out a bound connector.
          if (!this.draft) {
            const port = this.portAt(wx, wy);
            if (port) { this.startConnector(port, wx, wy, e); return; }
          }
          if (this.draft?.kind === "linear" && this.draft.item) {
            // Extend the multi-point element with another vertex.
            const p = this.linearPoint(wx, wy, e.shiftKey);
            this.draft.item.points!.push(p.x - this.draft.item.x, p.y - this.draft.item.y);
            normalizeLinear(this.draft.item);
            return;
          }
          const item = this.newItem(this.tool, wx, wy);
          item.points = [0, 0];
          this.draft = { kind: "linear", item, startWX: wx, startWY: wy, sx0: e.clientX, sy0: e.clientY, moved: false, linearDragged: false };
          break;
        }
        case "text": {
          const it = this.hitAt(wx, wy, 4);
          if (it && (it.kind === "text" || it.kind === "sticky")) this.openEditFor(it);
          else {
            // Click inside a container binds the text to it (Excalidraw).
            const host = this.containerAt(wx, wy);
            if (host) this.openEditFor(host);
            else this.spawnText(wx, wy);
          }
          break;
        }
        case "sticky": {
          const snapshot = this.cloneItems();
          const item = this.newItem("sticky", wx - 105, wy - 100);
          item.w = 210; item.h = 200; item.text = ""; item.font = "inter";
          this.wb.items.push(item);
          this.openEdit(item, "text", 0, true, snapshot);
          this.toolAfterDraw();
          this.dirty();
          break;
        }
        case "eraser": {
          this.draft = { kind: "erase", items0: this.cloneItems(), startWX: wx, startWY: wy, sx0: e.clientX, sy0: e.clientY, moved: false, eraseSet: new Set() };
          this.eraseAt(wx, wy);
          break;
        }
        case "select":
        default: {
          // Vertex handles on a selected line/arrow — drag to reshape or
          // re-bind an endpoint onto another shape.
          const vi = this.vertexAt(e.clientX, e.clientY);
          if (vi >= 0) {
            const it = this.selectionItems()[0]!;
            this.startVertexDrag(it, vi, e);
            return;
          }
          // Handles of the current selection win over item picking.
          const h = this.handleAt(e.clientX, e.clientY);
          if (h) {
            const sel = this.selectionItems();
            const box = this.selectionBox();
            if (!box) break;
            if (h === "rot") {
              const c = frameCenter(box.f);
              this.draft = {
                kind: "rotate", items0: this.cloneItems(), box0: box.f,
                angle0: Math.atan2(wy - c.y, wx - c.x),
                itemsAngle0: sel.map((i) => i.angle),
                resizeItems: sel.map((it) => ({ it, f: frameOf(it, this.measure) })),
                startWX: wx, startWY: wy, sx0: e.clientX, sy0: e.clientY, moved: false,
              };
            } else {
              this.draft = {
                kind: "resize", items0: this.cloneItems(), handle: h, box0: box.f,
                resizeItems: sel.map((it) => ({ it, f: frameOf(it, this.measure) })),
                startWX: wx, startWY: wy, sx0: e.clientX, sy0: e.clientY, moved: false, shift0: e.shiftKey,
              };
            }
            return;
          }
          // Drawio-style ports win over plain selection — they're visible on
          // hover, so a press on a port means "connect", not "select".
          const port = this.portAt(wx, wy);
          if (port) { this.startConnector(port, wx, wy, e); return; }
          const it = this.hitAt(wx, wy);
          if (it) {
            // Click selects (shift toggles); groups come along.
            const mates = new Set(it.group
              ? this.wb.items.filter((g) => g.group === it.group).map((g) => g.id)
              : [it.id]);
            if (e.shiftKey) {
              const allIn = [...mates].every((id) => this.selected.has(id));
              mates.forEach(id => {
                if (allIn) this.selected.delete(id);
                else this.selected.add(id);
              });
            } else if (!this.selected.has(it.id) || this.selectionItems().length > 1) {
              this.selected = mates;
            }
            this.draft = {
              kind: "move", items0: this.cloneItems(), startWX: wx, startWY: wy,
              sx0: e.clientX, sy0: e.clientY, moved: false,
            };
            this.pendingDbl = dbl ? { wx, wy } : null;
          } else {
            if (!e.shiftKey) this.selected.clear();
            this.draft = {
              kind: "marquee", marqueeAdd: e.shiftKey, startWX: wx, startWY: wy,
              sx0: e.clientX, sy0: e.clientY, moved: false,
            };
            this.pendingDbl = dbl ? { wx, wy } : null;
          }
          break;
        }
      }
    }, 55));

    this.unsubs.push(bus.onPointerMove((e) => {
      e = this.loc(e);
      this.cursor = { x: e.clientX, y: e.clientY };
      if (!this.active) return;
      if (this.menu) {
        this.menu.hover = hit(this.menuRect, e.clientX, e.clientY) ? this.menuIndexAt(e.clientY) : -1;
      }
      const d = this.draft;
      if (!d) return;
      // Hover moves (pointer up) only feed the cursor/ghost — they must not
      // advance a draft, or a click-mode multi-point line counts the move to
      // the next vertex as a "drag" and finishes early. (Track held state
      // ourselves: synthetic harness moves report buttons=0 mid-drag.)
      if (!this.pointerHeld) return;
      const wx = this.s2wX(e.clientX);
      const wy = this.s2wY(e.clientY);
      const z = this.wb.cam.zoom;
      if (Math.hypot(e.clientX - d.sx0, e.clientY - d.sy0) > 3) d.moved = true;

      switch (d.kind) {
        case "pen": {
          const pts = d.item!.points!;
          const lx = d.item!.x + pts[pts.length - 2]!;
          const ly = d.item!.y + pts[pts.length - 1]!;
          if (Math.hypot(wx - lx, wy - ly) > 1.2 / z) pts.push(wx - d.item!.x, wy - d.item!.y);
          break;
        }
        case "shape": {
          const it = d.item!;
          let w = wx - d.startWX, h = wy - d.startWY;
          if (e.shiftKey) {
            const m = Math.max(Math.abs(w), Math.abs(h));
            w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m;
          }
          it.w = w; it.h = h;
          break;
        }
        case "linear": {
          if (d.moved) d.linearDragged = true;
          break;
        }
        case "move": {
          if (!d.moved) break;
          let dx = wx - d.startWX, dy = wy - d.startWY;
          const sel = this.selectionItems();
          if (sel.length && !e.altKey) {
            const box = this.selectionBox();
            if (box) {
              const drag = { x: box.f.x + dx, y: box.f.y + dy, w: box.f.w, h: box.f.h };
              const others = this.wb.items.filter((i) => !sel.includes(i))
                .map((i) => this.aabbOf(i));
              const s = snapDelta(drag, others, 6 / z);
              dx += s.dx; dy += s.dy;
              this.snapGuide = (s.gx !== null || s.gy !== null) ? { gx: s.gx, gy: s.gy } : null;
            }
          }
          // Translate from pre-drag positions.
          if (!d.moveBase) {
            d.moveBase = new Map(sel.map((i) => [i.id, { x: i.x, y: i.y }]));
          }
          sel.forEach(it => {
            const b = d.moveBase!.get(it.id)!;
            it.x = b.x + dx;
            it.y = b.y + dy;
          });
          break;
        }
        case "resize": this.resizeMove(wx, wy, e.shiftKey); break;
        case "rotate": this.rotateMove(wx, wy, e.shiftKey); break;
        case "vertex": {
          const it = d.item!;
          const pts = it.points!;
          const f = frameOf(it, this.measure);
          const c = frameCenter(f);
          const l = it.angle ? unrot(wx, wy, c.x, c.y, it.angle) : { x: wx, y: wy };
          pts[d.vIdx! * 2] = l.x - it.x;
          pts[d.vIdx! * 2 + 1] = l.y - it.y;
          break;
        }
        case "marquee": break;
        case "pan": {
          this.wb.cam.x = d.camStart!.x - (e.clientX - d.sx0) / z;
          this.wb.cam.y = d.camStart!.y - (e.clientY - d.sy0) / z;
          break;
        }
        case "erase": this.eraseAt(wx, wy); break;
        case "slider": this.sliderMove(e.clientX); break;
      }
    }));

    this.unsubs.push(bus.onPointerUp((e) => {
      e = this.loc(e);
      this.pointerHeld = false;
      const d = this.draft;
      // Deferred double-click: a second press that never dragged edits the
      // item's text (or spawns text on empty canvas), Excalidraw-style.
      const pd = this.pendingDbl;
      this.pendingDbl = null;
      if (pd && d && !d.moved) {
        this.draft = null;
        const it = this.hitAt(pd.wx, pd.wy) ?? this.containerAt(pd.wx, pd.wy);
        if (it) this.openEditFor(it); else this.spawnText(pd.wx, pd.wy);
        return;
      }
      if (!d) return;
      this.snapGuide = null;
      switch (d.kind) {
        case "pen": {
          this.draft = null;
          const pts = d.item!.points ?? [];
          if (pts.length >= 4) {
            this.pushUndo();
            normalizeStroke(d.item!);
            this.wb.items.push(d.item!);
            this.dirty();
          }
          break;
        }
        case "shape": {
          this.draft = null;
          const it = d.item!;
          if (Math.abs(it.w) > 3 || Math.abs(it.h) > 3) {
            this.pushUndo();
            // Normalize negative extents into the frame.
            if (it.w < 0) { it.x += it.w; it.w = -it.w; }
            if (it.h < 0) { it.y += it.h; it.h = -it.h; }
            this.wb.items.push(it);
            this.selected = new Set([it.id]);
            this.toolAfterDraw();
            this.dirty();
          }
          break;
        }
        case "linear": {
          if (d.linearDragged) {
            // Dragged out a segment — finish as a single line.
            this.finishLinear();
            break;
          }
          // Click-mode: stay in the draft — each subsequent pointerdown
          // commits another vertex; Enter / Escape / double-click finish.
          return;
        }
        case "move": {
          this.draft = null;
          if (d.moved) {
            this.pushUndo(d.items0);
            this.dirty();
          }
          break;
        }
        case "resize":
        case "rotate": {
          this.draft = null;
          if (d.moved) {
            this.selectionItems().forEach(it => {
              if (it.points) {
                if (it.kind === "stroke") normalizeStroke(it);
                else normalizeLinear(it);
              }
              if (it.kind === "text") {
                const f = textFrame(it, this.measure);
                it.w = f.w; it.h = f.h;
              }
            });
            this.pushUndo(d.items0);
            this.dirty();
          }
          break;
        }
        case "vertex": {
          this.draft = null;
          const it = d.item!;
          if (d.moved) {
            const pts = it.points!;
            const n = pts.length / 2;
            if (d.vIdx === 0 || d.vIdx === n - 1) {
              const key = d.vIdx === 0 ? "bindStart" : "bindEnd";
              // Drop point in true world space (item-local → unrotated world
              // → rotated about the item frame center).
              const ux = it.x + pts[d.vIdx! * 2]!, uy = it.y + pts[d.vIdx! * 2 + 1]!;
              const f = frameOf(it, this.measure);
              const c = frameCenter(f);
              const w = it.angle ? rot(ux, uy, c.x, c.y, it.angle) : { x: ux, y: uy };
              const host = this.bindableHostAt(w.x, w.y, it);
              it[key] = host ? this.bindingAt(host, w.x, w.y) : undefined;
            }
            normalizeLinear(it);
            this.pushUndo(d.items0);
            this.dirty();
          }
          break;
        }
        case "marquee": {
          this.draft = null;
          if (d.moved) {
            const x0 = Math.min(this.s2wX(d.sx0), this.s2wX(e.clientX));
            const x1 = Math.max(this.s2wX(d.sx0), this.s2wX(e.clientX));
            const y0 = Math.min(this.s2wY(d.sy0), this.s2wY(e.clientY));
            const y1 = Math.max(this.s2wY(d.sy0), this.s2wY(e.clientY));
            const picked = new Set(d.marqueeAdd ? this.selected : []);
            this.wb.items.forEach(it => {
              const a = this.aabbOf(it);
              if (a.x < x1 && a.x + a.w > x0 && a.y < y1 && a.y + a.h > y0) {
                picked.add(it.id);
                if (it.group) {
                  this.wb.items.forEach(g => { if (g.group === it.group) picked.add(g.id); });
                }
              }
            });
            this.selected = picked;
          }
          break;
        }
        case "pan": {
          this.draft = null;
          if (d.moved) this.dirty();
          break;
        }
        case "erase": {
          this.draft = null;
          if (d.eraseSet && d.eraseSet.size > 0) {
            this.pushUndo(d.items0);
            this.dirty();
          }
          break;
        }
        case "slider": {
          this.draft = null;
          if (d.moved) this.pushUndo(d.items0);
          break;
        }
      }
    }));

    this.unsubs.push(bus.onWheel((e, ctrl) => {
      e = this.loc(e);
      if (!inCanvas(e.clientX, e.clientY)) return;
      ctrl.stopPropagation();
      const z = this.wb.cam.zoom;
      if (e.ctrlKey || e.metaKey) {
        const wx = this.s2wX(e.clientX), wy = this.s2wY(e.clientY);
        const nz = Math.max(0.1, Math.min(10, z * Math.exp(-e.deltaY * 0.0015)));
        this.wb.cam.x = wx - (e.clientX - this.rect.x) / nz;
        this.wb.cam.y = wy - (e.clientY - this.rect.y) / nz;
        this.wb.cam.zoom = nz;
      } else {
        this.wb.cam.x += e.deltaX / z;
        this.wb.cam.y += e.deltaY / z;
      }
      this.dirty();
    }, 55));

    this.unsubs.push(bus.onKeyDown((e, ctrl) => {
      if (!this.active) return;
      if (this.handleKey(e)) ctrl.stopPropagation();
    }, 60));

    this.unsubs.push(bus.onKeyUp((e) => {
      if (e.key === " ") this.spaceHeld = false;
    }, 60));

    // Native text input (real typing / IME). Dedupe against keydown chars —
    // synthetic dispatch_key events only produce keydown, real keys produce
    // both, so chars inserted via keydown are remembered briefly.
    const onText = (ev: Event) => {
      if (!this.active || !this.editing) return;
      const s = (ev as { text?: string; data?: string }).text ?? (ev as { data?: string }).data;
      if (!s || /^[\r\n]+$/.test(s)) return;
      const now = performance.now();
      let rest = "";
      Array.from(s).forEach(ch => {
        const idx = this.pendingChars.findIndex((p) => p.ch === ch && now - p.t < 120);
        if (idx >= 0) this.pendingChars.splice(idx, 1);
        else rest += ch;
      });
      if (rest) this.insertEditText(rest);
    };
    window.addEventListener("textinput", onText);
    this.unsubs.push(() => window.removeEventListener("textinput", onText));
  }

  private newItem(kind: WbItemKind, x: number, y: number): WbItem {
    const it = newWbItem(kind, x, y, this.style.color,
      kind === "text" || kind === "sticky" ? this.style.fontSize : this.style.size);
    it.fill = this.style.fill;
    it.fillStyle = this.style.fillStyle;
    it.strokeStyle = this.style.strokeStyle;
    it.roughness = this.style.roughness;
    it.round = this.style.round;
    it.opacity = this.style.opacity;
    it.font = this.style.font;
    if (kind === "arrow") it.endArrow = this.style.endArrow;
    else if (kind === "line") it.endArrow = "none";
    return it;
  }

  /** Excalidraw returns to the selection tool after a draw unless locked. */
  private toolAfterDraw(): void {
    if (!this.toolLocked) this.tool = "select";
  }

  // ── keys ────────────────────────────────────────────────────────────────────

  private handleKey(e: KeyboardEvent): boolean {
    const k = e.key;
    if (this.editing) return this.editKey(e);

    if (k === " " && !e.ctrlKey && !e.metaKey) {
      this.spaceHeld = true;
      return true;
    }
    if (k === "Escape") {
      if (this.draft?.kind === "linear") { this.cancelLinear(); return true; }
      if (this.menu) { this.menu = null; return true; }
      if (this.selected.size) { this.selected.clear(); return true; }
      if (this.tool !== "select") { this.tool = "select"; return true; }
      return false;
    }
    if (k === "Enter") {
      if (this.draft?.kind === "linear") { this.finishLinear(); return true; }
      const sel = this.selectionItems();
      if (sel.length === 1) { this.openEditFor(sel[0]!); return true; }
      return false;
    }

    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl) {
      switch (k.toLowerCase()) {
        case "z": if (e.shiftKey) this.redo(); else this.undo(); return true;
        case "y": this.redo(); return true;
        case "a": this.selected = new Set(this.wb.items.map((i) => i.id)); return true;
        case "c": this.copySelection(false); return true;
        case "x": this.copySelection(true); return true;
        case "v": this.paste(); return true;
        case "d": this.duplicate(); return true;
        case "g": if (e.shiftKey) this.ungroup(); else this.group(); return true;
        case "]": this.reorder(e.shiftKey ? "front" : "fwd"); return true;
        case "[": this.reorder(e.shiftKey ? "back" : "bwd"); return true;
        case "0": this.zoomReset(); return true;
        case "1": if (e.shiftKey) { this.zoomToFit(); return true; } break;
        case "2": if (e.shiftKey) { this.zoomToSelection(); return true; } break;
        case "=": case "+": this.zoomStep(1.25); return true;
        case "-": this.zoomStep(1 / 1.25); return true;
        case "'": this.wb.grid = !this.wbGrid; this.dirty(); return true;
      }
      return false;
    }

    if (k === "Delete" || k === "Backspace") {
      if (this.selected.size) { this.deleteSelection(); return true; }
      return false;
    }
    if (k === "1" && e.shiftKey) { this.zoomToFit(); return true; }
    if (k === "!" ) { this.zoomToFit(); return true; }
    if (k === "2" && e.shiftKey) { this.zoomToSelection(); return true; }
    if (k === "@" ) { this.zoomToSelection(); return true; }
    if (k === "=" || k === "+") { this.zoomStep(1.25); return true; }
    if (k === "-") { this.zoomStep(1 / 1.25); return true; }

    if (k.startsWith("Arrow")) {
      const sel = this.selectionItems();
      if (!sel.length) return false;
      this.pushUndo();
      const d = e.shiftKey ? 10 : 1;
      const dx = k === "ArrowLeft" ? -d : k === "ArrowRight" ? d : 0;
      const dy = k === "ArrowUp" ? -d : k === "ArrowDown" ? d : 0;
      sel.forEach(it => { it.x += dx; it.y += dy; });
      this.dirty();
      return true;
    }

    // Tool shortcuts — digits mirror the toolbar, letters match Excalidraw.
    const digit = TOOLS.find((t) => t.num === k);
    if (digit) { this.tool = digit.id; return true; }
    const toolKeys: Record<string, Tool> = {
      v: "select", h: "hand", r: "rect", d: "diamond", o: "ellipse",
      a: "arrow", l: "line", p: "pen", t: "text", s: "sticky", e: "eraser",
    };
    const tk = toolKeys[k.toLowerCase()];
    if (tk) { this.tool = tk; return true; }
    return false;
  }

  // ── eraser ──────────────────────────────────────────────────────────────────

  private eraseAt(wx: number, wy: number): void {
    const d = this.draft;
    if (!d || d.kind !== "erase") return;
    const r = 10 / this.wb.cam.zoom;
    const doomed: string[] = [];
    this.wb.items.forEach(it => {
      if (d.eraseSet!.has(it.id)) return;
      if (eraserHits(it, wx, wy, r, this.measure, this.wb.items)) doomed.push(it.id);
    });
    if (doomed.length) {
      const drop = new Set(doomed);
      // Also erase arrows bound to a deleted shape.
      this.wb.items.forEach(it => {
        if (it.bindStart && drop.has(it.bindStart.id)) drop.add(it.id);
        if (it.bindEnd && drop.has(it.bindEnd.id)) drop.add(it.id);
      });
      this.wb.items = this.wb.items.filter((i) => !drop.has(i.id));
      drop.forEach(id => { d.eraseSet!.add(id); this.selected.delete(id); });
    }
  }

  // ── linear elements ──────────────────────────────────────────────────────────

  /** Current segment endpoint for an in-progress linear draft — snapped to
   *  15° under shift. */
  private linearPoint(wx: number, wy: number, shift: boolean): { x: number; y: number } {
    const d = this.draft;
    if (!d?.item?.points || d.item.points.length < 2) return { x: wx, y: wy };
    const p = d.item.points;
    const lx = d.item.x + p[p.length - 2]!, ly = d.item.y + p[p.length - 1]!;
    if (!shift) return { x: wx, y: wy };
    const ang = Math.atan2(wy - ly, wx - lx);
    const snapped = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
    const len = Math.hypot(wx - lx, wy - ly);
    return { x: lx + Math.cos(snapped) * len, y: ly + Math.sin(snapped) * len };
  }

  private finishLinear(): void {
    const d = this.draft;
    if (!d || d.kind !== "linear" || !d.item) return;
    this.draft = null;
    const it = d.item;
    const p = it.points!;
    if (d.linearDragged && p.length === 2) {
      // Drag-created: the release point is the second vertex.
      const end = this.linearPoint(this.s2wX(this.cursor.x), this.s2wY(this.cursor.y), false);
      p.push(end.x - it.x, end.y - it.y);
    }
    // Drop a trailing vertex that duplicates its predecessor (double-click
    // finishes leave one behind).
    for (; p.length >= 4 &&
        Math.hypot(p[p.length - 2]! - p[p.length - 4]!, p[p.length - 1]! - p[p.length - 3]!) < 3;) {
      p.splice(p.length - 2, 2);
    }
    normalizeLinear(it);
    const span = Math.hypot(it.w, it.h);
    if (span > 3) {
      this.pushUndo();
      this.bindEnds(it);
      this.wb.items.push(it);
      this.selected = new Set([it.id]);
      this.toolAfterDraw();
      this.dirty();
    }
  }

  private cancelLinear(): void {
    this.draft = null;
  }

  /** Topmost bindable shape whose (tolerance-expanded) frame contains the
   *  point — arrow endpoints bind on containment, not stroke-hit. */
  private bindableHostAt(wx: number, wy: number, exclude: WbItem): WbItem | null {
    const tol = 18 / this.wb.cam.zoom;
    for (let i = this.wb.items.length - 1; i >= 0; i--) {
      const it = this.wb.items[i]!;
      if (it === exclude) continue;
      if (it.kind !== "rect" && it.kind !== "diamond" && it.kind !== "ellipse" && it.kind !== "sticky") continue;
      const f = frameOf(it, this.measure);
      const c = frameCenter(f);
      const p = it.angle ? unrot(wx, wy, c.x, c.y, it.angle) : { x: wx, y: wy };
      if (p.x >= f.x - tol && p.x <= f.x + f.w + tol && p.y >= f.y - tol && p.y <= f.y + f.h + tol) return it;
    }
    return null;
  }

  /** Bind arrow endpoints that land inside/near a shape. */
  private bindEnds(it: WbItem): void {
    if (it.kind !== "arrow" && it.kind !== "line") return;
    const p = it.points!;
    const ends: { key: "bindStart" | "bindEnd"; wx: number; wy: number }[] = [
      { key: "bindStart", wx: it.x + p[0]!, wy: it.y + p[1]! },
      { key: "bindEnd", wx: it.x + p[p.length - 2]!, wy: it.y + p[p.length - 1]! },
    ];
    ends.forEach(e => {
      const host = this.bindableHostAt(e.wx, e.wy, it);
      if (host) {
        it[e.key] = this.bindingAt(host, e.wx, e.wy) ?? undefined;
      }
    });
  }

  /** Binding record for a world point on a host (host-frame fractions). */
  private bindingAt(host: WbItem, wx: number, wy: number): WbItem["bindStart"] {
    const f = frameOf(host, this.measure);
    const c = frameCenter(f);
    const l = host.angle ? unrot(wx, wy, c.x, c.y, host.angle) : { x: wx, y: wy };
    return {
      id: host.id,
      fx: Math.max(0, Math.min(1, (l.x - f.x) / (f.w || 1))),
      fy: Math.max(0, Math.min(1, (l.y - f.y) / (f.h || 1))),
    };
  }

  // ── connection ports ─────────────────────────────────────────────────────────

  /** The four edge-midpoint connection ports of a container, world coords. */
  private portsOf(host: WbItem): { x: number; y: number; fx: number; fy: number }[] {
    const f = frameOf(host, this.measure);
    const c = frameCenter(f);
    const mids = [
      { fx: 0.5, fy: 0 }, { fx: 1, fy: 0.5 }, { fx: 0.5, fy: 1 }, { fx: 0, fy: 0.5 },
    ];
    return mids.map((m) => {
      const lx = f.x + m.fx * f.w, ly = f.y + m.fy * f.h;
      const w = host.angle ? rot(lx, ly, c.x, c.y, host.angle) : { x: lx, y: ly };
      return { x: w.x, y: w.y, fx: m.fx, fy: m.fy };
    });
  }

  /** Whether ports show for this item — connectable containers only, and for
   *  the select tool only when unselected (selected shapes show resize handles
   *  at the same edge midpoints; the square handles mean "resize"). */
  private portable(it: WbItem): boolean {
    if (it.kind !== "rect" && it.kind !== "diamond" && it.kind !== "ellipse" && it.kind !== "sticky") return false;
    if (this.tool === "select" && this.selected.has(it.id)) return false;
    return true;
  }

  /** Container currently showing connection ports: the topmost portable shape
   *  under the cursor. */
  private portHostAtCursor(): WbItem | null {
    const wx = this.s2wX(this.cursor.x), wy = this.s2wY(this.cursor.y);
    for (let i = this.wb.items.length - 1; i >= 0; i--) {
      const it = this.wb.items[i]!;
      if (!this.portable(it)) continue;
      const f = frameOf(it, this.measure);
      const c = frameCenter(f);
      const p = it.angle ? unrot(wx, wy, c.x, c.y, it.angle) : { x: wx, y: wy };
      if (p.x >= f.x - 8 && p.x <= f.x + f.w + 8 && p.y >= f.y - 8 && p.y <= f.y + f.h + 8) return it;
    }
    return null;
  }

  /** Port (host + anchor fractions) under a world point, within hit tol. */
  private portAt(wx: number, wy: number): { host: WbItem; fx: number; fy: number } | null {
    const tol = 9 / this.wb.cam.zoom;
    for (let i = this.wb.items.length - 1; i >= 0; i--) {
      const host = this.wb.items[i]!;
      if (!this.portable(host)) continue;
      const f = frameOf(host, this.measure);
      const c = frameCenter(f);
      const p = host.angle ? unrot(wx, wy, c.x, c.y, host.angle) : { x: wx, y: wy };
      if (p.x < f.x - tol * 2 || p.x > f.x + f.w + tol * 2 ||
          p.y < f.y - tol * 2 || p.y > f.y + f.h + tol * 2) continue;
      const port = this.portsOf(host).find(port => Math.hypot(wx - port.x, wy - port.y) <= tol);
      if (port) return { host, fx: port.fx, fy: port.fy };
    }
    return null;
  }

  /** Begin a connector drag from a port: a pre-bound arrow (or line under the
   *  line tool) whose start tracks the host edge while dragging. */
  private startConnector(port: { host: WbItem; fx: number; fy: number },
    wx: number, wy: number, e: PointerEvent): void {
    const item = this.newItem(this.tool === "line" ? "line" : "arrow", wx, wy);
    item.points = [0, 0];
    item.bindStart = { id: port.host.id, fx: port.fx, fy: port.fy };
    this.draft = {
      kind: "linear", item, startWX: wx, startWY: wy,
      sx0: e.clientX, sy0: e.clientY, moved: false, linearDragged: false,
    };
  }

  /** Vertex (endpoint/midpoint) circles of the single selected linear item,
   *  screen coords — drawio-style draggable connectors/vertices. */
  private vertexHandles(): { idx: number; x: number; y: number; mid: boolean }[] {
    const sel = this.selectionItems();
    if (sel.length !== 1) return [];
    const it = sel[0]!;
    if ((it.kind !== "line" && it.kind !== "arrow") || !it.points) return [];
    const pts = resolvedPoints(it, this.wb.items, this.measure);
    // resolvedPoints is in the item's unrotated world frame — rotate to true
    // world when the item carries an angle.
    const f = frameOf(it, this.measure);
    const c = frameCenter(f);
    const toScreen = (lx: number, ly: number) => {
      const w = it.angle ? rot(lx, ly, c.x, c.y, it.angle) : { x: lx, y: ly };
      return { x: this.w2sX(w.x), y: this.w2sY(w.y) };
    };
    const out: { idx: number; x: number; y: number; mid: boolean }[] = [];
    const n = pts.length / 2;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const s = toScreen(pts[i]!, pts[i + 1]!);
      out.push({ idx: i / 2, x: s.x, y: s.y, mid: false });
      // Segment midpoint — dragging it inserts a bend (drawio-style).
      if (i + 3 < pts.length) {
        const m = toScreen((pts[i]! + pts[i + 2]!) / 2, (pts[i + 1]! + pts[i + 3]!) / 2);
        if (Math.hypot(m.x - s.x, m.y - s.y) > 14) out.push({ idx: i / 2 + 0.5, x: m.x, y: m.y, mid: true });
      }
    }
    return out;
  }

  private vertexAt(sx: number, sy: number): number {
    const v = this.vertexHandles().find(v => {
      const tol = v.mid ? 6 : 7;
      return Math.abs(sx - v.x) <= tol && Math.abs(sy - v.y) <= tol;
    });
    return v ? v.idx : -1;
  }

  /** Drag a linear vertex; endpoints re-bind (or detach) on release. A
   *  fractional `idx` marks a segment midpoint — inserting a bend there. */
  private startVertexDrag(it: WbItem, idx: number, e: PointerEvent): void {
    const pts = it.points!;
    if (idx !== Math.floor(idx)) {
      // Bend insert: the midpoint handle becomes a real vertex.
      const seg = Math.floor(idx);
      const res = resolvedPoints(it, this.wb.items, this.measure);
      const mx = (res[seg * 2]! + res[seg * 2 + 2]!) / 2 - it.x;
      const my = (res[seg * 2 + 1]! + res[seg * 2 + 3]!) / 2 - it.y;
      pts.splice((seg + 1) * 2, 0, mx, my);
      normalizeLinear(it);
      idx = seg + 1;
    }
    const n = pts.length / 2;
    // Materialize the resolved (bound-clipped) vertex into the raw point so
    // dragging starts from where the handle was drawn, without a jump.
    if ((idx === 0 && it.bindStart) || (idx === n - 1 && it.bindEnd)) {
      const res = resolvedPoints(it, this.wb.items, this.measure);
      pts[idx * 2] = res[idx * 2]! - it.x;
      pts[idx * 2 + 1] = res[idx * 2 + 1]! - it.y;
      if (idx === 0) it.bindStart = undefined; else it.bindEnd = undefined;
    }
    this.draft = {
      kind: "vertex", item: it, vIdx: idx, items0: this.cloneItems(),
      startWX: this.s2wX(e.clientX), startWY: this.s2wY(e.clientY),
      sx0: e.clientX, sy0: e.clientY, moved: false,
    };
  }

  // ── text editing ────────────────────────────────────────────────────────────

  private openEditFor(it: WbItem): void {
    if (it.kind === "text" || it.kind === "sticky") {
      this.openEdit(it, "text", (it.text ?? "").length, false);
    } else {
      if (it.fontSize === undefined) it.fontSize = this.style.fontSize;
      this.openEdit(it, "boundText", (it.boundText ?? "").length, false);
    }
  }

  private openEdit(it: WbItem, field: "text" | "boundText", caret: number, isNew: boolean,
    snapshot?: WbItem[]): void {
    this.editing = {
      itemId: it.id, field, caret, anchor: caret, isNew,
      orig: (field === "text" ? it.text : it.boundText) ?? "",
      snapshot: snapshot ?? this.cloneItems(),
    };
    this.selected = new Set([it.id]);
    this.blinkT = 0;
  }

  private spawnText(wx: number, wy: number): void {
    const snapshot = this.cloneItems();
    const item = this.newItem("text", wx, wy);
    item.text = "";
    this.wb.items.push(item);
    this.openEdit(item, "text", 0, true, snapshot);
    this.toolAfterDraw();
    this.dirty();
  }

  private editItem(): WbItem | null {
    if (!this.editing) return null;
    return this.wb.items.find((i) => i.id === this.editing!.itemId) ?? null;
  }

  private commitEdit(): void {
    const e = this.editing;
    if (!e) return;
    this.editing = null;
    const item = this.wb.items.find((i) => i.id === e.itemId);
    const cur = item ? ((e.field === "text" ? item.text : item.boundText) ?? "") : "";
    if (item && !cur.trim() && e.isNew) {
      this.wb.items = this.wb.items.filter((i) => i.id !== e.itemId);
      this.selected.delete(e.itemId);
      this.dirty();
      return;
    }
    if (cur !== e.orig) {
      this.pushUndo(e.snapshot);
      this.dirty();
    }
  }

  private editText(): string {
    const it = this.editItem();
    if (!it || !this.editing) return "";
    return (this.editing.field === "text" ? it.text : it.boundText) ?? "";
  }

  private setEditText(s: string): void {
    const it = this.editItem();
    if (!it || !this.editing) return;
    if (this.editing.field === "text") it.text = s;
    else it.boundText = s;
  }

  insertEditTextPublic(s: string): void { this.insertEditText(s); }

  private insertEditText(s: string): void {
    const e = this.editing;
    if (!e) return;
    const t = this.editText();
    const lo = Math.min(e.caret, e.anchor), hi = Math.max(e.caret, e.anchor);
    const next = t.slice(0, lo) + s + t.slice(hi);
    this.setEditText(next);
    e.caret = lo + s.length;
    e.anchor = e.caret;
    this.blinkT = 0;
    this.dirty();
  }

  private deleteSel(): boolean {
    const e = this.editing!;
    if (e.caret === e.anchor) return false;
    const t = this.editText();
    const lo = Math.min(e.caret, e.anchor), hi = Math.max(e.caret, e.anchor);
    this.setEditText(t.slice(0, lo) + t.slice(hi));
    e.caret = lo; e.anchor = lo;
    return true;
  }

  private moveCaretTo(idx: number, extend: boolean): void {
    const e = this.editing!;
    idx = Math.max(0, Math.min(this.editText().length, idx));
    e.caret = idx;
    if (!extend) e.anchor = idx;
    this.blinkT = 0;
  }

  /** Map a click to a caret index for the item being edited. */
  private clickToCaret(it: WbItem, sx: number, sy: number, extend: boolean): void {
    const e = this.editing!;
    const f = frameOf(it, this.measure);
    const c = frameCenter(f);
    let lx = this.s2wX(sx), ly = this.s2wY(sy);
    const p = it.angle ? unrot(lx, ly, c.x, c.y, it.angle) : { x: lx, y: ly };
    const str = this.editText();
    const lay = textLayout(it, str, this.measure);
    const isBound = e.field === "boundText";
    const fs = wbFontSize(it);
    const topPad = it.kind === "sticky" ? 34 : 0;
    const totalH = lay.lines.length * fs * LINE_H;
    const startY = isBound && it.kind !== "sticky"
      ? f.y + Math.max(8, (f.h - totalH) / 2)
      : f.y + topPad;
    const li = Math.max(0, Math.min(lay.lines.length - 1, Math.floor((p.y - startY) / (fs * LINE_H))));
    const line = lay.lines[li]!;
    const baseX = isBound && it.kind !== "sticky"
      ? f.x + f.w / 2 - this.measure(it.font, fs, line.str) / 2
      : f.x + lay.padX;
    // Column via prefix-measure walk.
    let col = 0;
    for (let i = 0; i <= line.str.length; i++) {
      const w = this.measure(it.font, fs, line.str.slice(0, i));
      const wNext = this.measure(it.font, fs, line.str.slice(0, i + 1));
      if (p.x - baseX < (w + wNext) / 2) { col = i; break; }
      col = i + 1;
    }
    this.moveCaretTo(Math.min(str.length, line.start + Math.min(col, line.str.length)), extend);
  }

  private editKey(e: KeyboardEvent): boolean {
    const k = e.key;
    const ed = this.editing!;
    if (k === "Escape") { this.commitEdit(); return true; }
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl) {
      switch (k.toLowerCase()) {
        case "a": ed.anchor = 0; ed.caret = this.editText().length; return true;
        case "c": return true; // selection copy — clipboard handled app-wide
        case "z": this.commitEdit(); this.undo(); return true;
        case "y": this.commitEdit(); this.redo(); return true;
        case "arrowleft": this.moveCaretTo(this.wordEdge(-1), e.shiftKey); return true;
        case "arrowright": this.moveCaretTo(this.wordEdge(1), e.shiftKey); return true;
        case "backspace": {
          if (!this.deleteSel()) {
            const t = this.editText();
            const edge = this.wordEdge(-1);
            this.setEditText(t.slice(0, edge) + t.slice(ed.caret));
            ed.caret = edge; ed.anchor = edge;
          }
          this.dirty();
          return true;
        }
      }
      return true;
    }
    switch (k) {
      case "Backspace": {
        if (!this.deleteSel() && ed.caret > 0) {
          const t = this.editText();
          this.setEditText(t.slice(0, ed.caret - 1) + t.slice(ed.caret));
          ed.caret -= 1; ed.anchor = ed.caret;
        }
        this.dirty();
        return true;
      }
      case "Delete": {
        if (!this.deleteSel() && ed.caret < this.editText().length) {
          const t = this.editText();
          this.setEditText(t.slice(0, ed.caret) + t.slice(ed.caret + 1));
        }
        this.dirty();
        return true;
      }
      case "Enter": this.insertEditText("\n"); return true;
      case "ArrowLeft": this.moveCaretTo(ed.caret - 1, e.shiftKey); return true;
      case "ArrowRight": this.moveCaretTo(ed.caret + 1, e.shiftKey); return true;
      case "ArrowUp": this.moveCaretTo(this.lineDelta(-1), e.shiftKey); return true;
      case "ArrowDown": this.moveCaretTo(this.lineDelta(1), e.shiftKey); return true;
      case "Home": this.moveCaretTo(this.lineStart(), e.shiftKey); return true;
      case "End": this.moveCaretTo(this.lineEnd(), e.shiftKey); return true;
      default:
        if (k.length === 1) {
          this.pendingChars.push({ ch: k, t: performance.now() });
          if (this.pendingChars.length > 32) this.pendingChars.shift();
          this.insertEditText(k);
          return true;
        }
        return false;
    }
  }

  private wordEdge(dir: -1 | 1): number {
    const t = this.editText();
    let i = this.editing!.caret;
    if (dir < 0) {
      for (; i > 0 && /\s/.test(t[i - 1]!); i--) {}
      for (; i > 0 && !/\s/.test(t[i - 1]!); i--) {}
    } else {
      for (; i < t.length && /\s/.test(t[i]!); i++) {}
      for (; i < t.length && !/\s/.test(t[i]!); i++) {}
    }
    return i;
  }

  private lineStart(): number {
    const t = this.editText();
    const i = this.editing!.caret;
    const nl = t.lastIndexOf("\n", i - 1);
    return nl + 1;
  }

  private lineEnd(): number {
    const t = this.editText();
    const i = this.editing!.caret;
    const nl = t.indexOf("\n", i);
    return nl < 0 ? t.length : nl;
  }

  /** Caret index one visual line up/down, keeping the column. */
  private lineDelta(dir: -1 | 1): number {
    const it = this.editItem()!;
    const e = this.editing!;
    const str = this.editText();
    const lay = textLayout(it, str, this.measure);
    let li = 0;
    for (let i = 0; i < lay.lines.length; i++) {
      if (e.caret <= lay.lines[i]!.start + lay.lines[i]!.str.length) { li = i; break; }
    }
    const line = lay.lines[li]!;
    const col = e.caret - line.start;
    const next = lay.lines[li + dir];
    if (!next) return e.caret;
    // Same pixel column in the target line.
    const fs = wbFontSize(it);
    const targetW = this.measure(it.font, fs, line.str.slice(0, col));
    let col2 = 0;
    for (let i = 0; i <= next.str.length; i++) {
      const w = this.measure(it.font, fs, next.str.slice(0, i));
      const wN = this.measure(it.font, fs, next.str.slice(0, i + 1));
      if (targetW < (w + wN) / 2) { col2 = i; break; }
      col2 = i + 1;
    }
    return next.start + Math.min(col2, next.str.length);
  }

  // ── clipboard / ordering / grouping ──────────────────────────────────────────

  private copySelection(cut: boolean): void {
    const sel = this.selectionItems();
    if (!sel.length) return;
    this.clipboard = JSON.parse(JSON.stringify(sel)) as WbItem[];
    try {
      (navigator as { clipboard?: { writeText?: (s: string) => void } })
        .clipboard?.writeText?.(JSON.stringify({ app: "salticus", items: this.clipboard }));
    } catch { /* no system clipboard — internal only */ }
    if (cut) this.deleteSelection();
  }

  private paste(): void {
    const src = this.clipboard;
    if (!src.length) return;
    this.pushUndo();
    const box = combineAABBs(src.map((i) => frameOf(i, this.measure)));
    const cx = this.s2wX(this.cursor.x || (this.rect.x + this.rect.w / 2));
    const cy = this.s2wY(this.cursor.y || (this.rect.y + this.rect.h / 2));
    const dx = cx - (box.x + box.w / 2), dy = cy - (box.y + box.h / 2);
    const gid = newId("grp");
    const news: WbItem[] = src.map((i) => {
      const it = JSON.parse(JSON.stringify(i)) as WbItem;
      it.id = newId("wb");
      it.x += dx; it.y += dy;
      if (i.group) it.group = `${i.group}+${gid}`;
      it.bindStart = null; it.bindEnd = null;
      return it;
    });
    this.wb.items.push(...news);
    this.selected = new Set(news.map((i) => i.id));
    this.dirty();
  }

  private duplicate(): void {
    const sel = this.selectionItems();
    if (!sel.length) return;
    this.pushUndo();
    const idMap = new Map<string, string>();
    const news = sel.map((i) => {
      const it = JSON.parse(JSON.stringify(i)) as WbItem;
      idMap.set(i.id, newId("wb"));
      return it;
    });
    for (let i = 0; i < news.length; i++) {
      news[i]!.id = idMap.get(sel[i]!.id)!;
      news[i]!.x += 16; news[i]!.y += 16;
      if (news[i]!.bindStart && idMap.has(news[i]!.bindStart!.id)) news[i]!.bindStart!.id = idMap.get(news[i]!.bindStart!.id)!;
      else news[i]!.bindStart = null;
      if (news[i]!.bindEnd && idMap.has(news[i]!.bindEnd!.id)) news[i]!.bindEnd!.id = idMap.get(news[i]!.bindEnd!.id)!;
      else news[i]!.bindEnd = null;
      if (sel[i]!.group) news[i]!.group = sel[i]!.group;
    }
    // Regroup duplicates under their own group ids.
    const gmap = new Map<string, string>();
    news.forEach(it => {
      if (!it.group) return;
      if (!gmap.has(it.group)) gmap.set(it.group, newId("grp"));
      it.group = gmap.get(it.group)!;
    });
    this.wb.items.push(...news);
    this.selected = new Set(news.map((i) => i.id));
    this.dirty();
  }

  private deleteSelection(): void {
    const sel = this.selectionItems();
    if (!sel.length) return;
    this.pushUndo();
    const ids = new Set(sel.map((i) => i.id));
    this.wb.items = this.wb.items.filter((i) => !ids.has(i.id));
    // Clear dangling bindings.
    this.wb.items.forEach(it => {
      if (it.bindStart && ids.has(it.bindStart.id)) it.bindStart = null;
      if (it.bindEnd && ids.has(it.bindEnd.id)) it.bindEnd = null;
    });
    this.selected.clear();
    this.dirty();
  }

  private reorder(how: "fwd" | "bwd" | "front" | "back"): void {
    const sel = this.selectionItems();
    if (!sel.length) return;
    this.pushUndo();
    const ids = new Set(sel.map((i) => i.id));
    const items = this.wb.items;
    if (how === "front") {
      this.wb.items = [...items.filter((i) => !ids.has(i.id)), ...items.filter((i) => ids.has(i.id))];
    } else if (how === "back") {
      this.wb.items = [...items.filter((i) => ids.has(i.id)), ...items.filter((i) => !ids.has(i.id))];
    } else if (how === "fwd") {
      for (let i = items.length - 2; i >= 0; i--) {
        if (ids.has(items[i]!.id) && !ids.has(items[i + 1]!.id)) {
          const t = items[i]!; items[i] = items[i + 1]!; items[i + 1] = t;
        }
      }
    } else {
      for (let i = 1; i < items.length; i++) {
        if (ids.has(items[i]!.id) && !ids.has(items[i - 1]!.id)) {
          const t = items[i]!; items[i] = items[i - 1]!; items[i - 1] = t;
        }
      }
    }
    this.dirty();
  }

  private group(): void {
    const sel = this.selectionItems();
    if (sel.length < 2) return;
    this.pushUndo();
    const g = newId("grp");
    sel.forEach(it => { it.group = g; });
    this.dirty();
  }

  private ungroup(): void {
    const sel = this.selectionItems();
    if (!sel.some((i) => i.group)) return;
    this.pushUndo();
    sel.forEach(it => { it.group = undefined; });
    this.dirty();
  }

  /** Alignment for multi-selection (context menu + panel actions). */
  private align(mode: "left" | "cx" | "right" | "top" | "cy" | "bottom"): void {
    const sel = this.selectionItems();
    if (sel.length < 2) return;
    this.pushUndo();
    const box = combineAABBs(sel.map((i) => this.aabbOf(i)));
    sel.forEach(it => {
      const a = this.aabbOf(it);
      if (mode === "left") it.x += box.x - a.x;
      else if (mode === "cx") it.x += (box.x + box.w / 2) - (a.x + a.w / 2);
      else if (mode === "right") it.x += (box.x + box.w) - (a.x + a.w);
      else if (mode === "top") it.y += box.y - a.y;
      else if (mode === "cy") it.y += (box.y + box.h / 2) - (a.y + a.h / 2);
      else it.y += (box.y + box.h) - (a.y + a.h);
    });
    this.dirty();
  }

  private distribute(axis: "h" | "v"): void {
    const sel = this.selectionItems();
    if (sel.length < 3) return;
    this.pushUndo();
    const entries = sel.map((i) => ({ it: i, a: this.aabbOf(i) }));
    entries.sort((m, n) => axis === "h" ? m.a.x - n.a.x : m.a.y - n.a.y);
    const first = entries[0]!, last = entries[entries.length - 1]!;
    const span = axis === "h" ? (last.a.x + last.a.w / 2) - (first.a.x + first.a.w / 2)
      : (last.a.y + last.a.h / 2) - (first.a.y + first.a.h / 2);
    const step = span / (entries.length - 1);
    for (let i = 1; i < entries.length - 1; i++) {
      const target = axis === "h" ? first.a.x + first.a.w / 2 + step * i
        : first.a.y + first.a.h / 2 + step * i;
      const e = entries[i]!;
      const cur = axis === "h" ? e.a.x + e.a.w / 2 : e.a.y + e.a.h / 2;
      if (axis === "h") e.it.x += target - cur;
      else e.it.y += target - cur;
    }
    this.dirty();
  }

  /** Unrotated local frame — for bound linears this follows the resolved
   *  (edge-clipped) endpoints rather than the stale raw frame. */
  private localFrame(it: WbItem): Frame {
    if ((it.kind === "line" || it.kind === "arrow") && (it.bindStart || it.bindEnd)) {
      const pts = resolvedPoints(it, this.wb.items, this.measure);
      const cs: { x: number; y: number }[] = [];
      for (let i = 0; i + 1 < pts.length; i += 2) cs.push({ x: pts[i]!, y: pts[i + 1]! });
      if (cs.length) return combineAABBs(cs.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })));
    }
    return frameOf(it, this.measure);
  }

  private aabbOf(it: WbItem): Frame {
    const f = this.localFrame(it);
    if (!it.angle) return f;
    const c = frameCenter(f);
    const cs = [[f.x, f.y], [f.x + f.w, f.y], [f.x + f.w, f.y + f.h], [f.x, f.y + f.h]]
      .map(([x, y]) => rot(x!, y!, c.x, c.y, it.angle));
    return combineAABBs(cs.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })));
  }

  // ── resize / rotate ─────────────────────────────────────────────────────────

  private resizeMove(wx: number, wy: number, shift: boolean): void {
    const d = this.draft;
    if (!d || d.kind !== "resize" || !d.box0 || !d.resizeItems) return;
    const F0 = d.box0;
    const single = d.resizeItems.length === 1 ? d.resizeItems[0]!.it : null;
    const angle = single ? single.angle : 0;
    const c0 = frameCenter(F0);
    // Pointer in the box's local frame.
    const p = angle ? unrot(wx, wy, c0.x, c0.y, angle) : { x: wx, y: wy };
    const m = this.handleMask(d.handle!);
    const min = 4;

    // Anchor = opposite edge (local coords).
    const ax = m.ex < 0 ? F0.x + F0.w : m.ex > 0 ? F0.x : F0.x + F0.w / 2;
    const ay = m.ey < 0 ? F0.y + F0.h : m.ey > 0 ? F0.y : F0.y + F0.h / 2;
    let w1 = m.ex === 0 ? F0.w : Math.max(min, Math.abs(p.x - ax));
    let h1 = m.ey === 0 ? F0.h : Math.max(min, Math.abs(p.y - ay));
    if (shift && m.ex !== 0 && m.ey !== 0) {
      const k = Math.max(w1 / F0.w, h1 / F0.h);
      w1 = Math.max(min, F0.w * k);
      h1 = Math.max(min, F0.h * k);
    }

    let F1: Frame;
    if (single && angle) {
      // Keep the anchor fixed in world space under rotation.
      const A = { x: ax, y: ay };
      const Aw = rot(A.x, A.y, c0.x, c0.y, angle);
      const b = { x: -m.ex * w1 / 2, y: -m.ey * h1 / 2 };
      const Rb = rot(b.x, b.y, 0, 0, angle);
      const o1 = { x: Aw.x - Rb.x, y: Aw.y - Rb.y };
      F1 = { x: o1.x - w1 / 2, y: o1.y - h1 / 2, w: w1, h: h1 };
    } else {
      const nx = m.ex < 0 ? ax - w1 : m.ex > 0 ? ax : F0.x + (F0.w - w1) / 2;
      const ny = m.ey < 0 ? ay - h1 : m.ey > 0 ? ay : F0.y + (F0.h - h1) / 2;
      F1 = { x: nx, y: ny, w: w1, h: h1 };
    }

    if (single) {
      this.applyResize(single, d.resizeItems[0]!.f, F1, m);
    } else {
      // Scale every selected item's frame into the new box.
      const sx = w1 / (F0.w || 1), sy = h1 / (F0.h || 1);
      d.resizeItems.forEach(r => {
        const nf: Frame = {
          x: F1.x + (r.f.x - F0.x) * sx,
          y: F1.y + (r.f.y - F0.y) * sy,
          w: r.f.w * sx,
          h: r.f.h * sy,
        };
        this.applyResize(r.it, r.f, nf, { ex: 1, ey: 1 });
      });
    }
  }

  /** Write a resized frame back into an item (scales points, fonts). */
  private applyResize(it: WbItem, f0: Frame, f1: Frame, m: { ex: number; ey: number }): void {
    if (it.kind === "text") {
      const kx = f1.w / (f0.w || 1), ky = f1.h / (f0.h || 1);
      const k = m.ex !== 0 && m.ey !== 0 ? (kx + ky) / 2 : (m.ex !== 0 ? kx : ky);
      it.size = Math.max(6, Math.min(200, it.size * Math.max(0.2, k)));
      const f = textFrame(it, this.measure);
      it.w = f.w; it.h = f.h;
      // Anchor top-left-ish to the resized frame origin.
      it.x = f1.x; it.y = f1.y;
      return;
    }
    it.x = f1.x; it.y = f1.y; it.w = f1.w; it.h = f1.h;
    if (it.points && it.points.length >= 2) {
      const sx = f1.w / (f0.w || 1), sy = f1.h / (f0.h || 1);
      for (let i = 0; i + 1 < it.points.length; i += 2) {
        it.points[i] = it.points[i]! * sx;
        it.points[i + 1] = it.points[i + 1]! * sy;
      }
    }
  }

  private rotateMove(wx: number, wy: number, shift: boolean): void {
    const d = this.draft;
    if (!d || d.kind !== "rotate" || !d.box0 || !d.resizeItems) return;
    const c = frameCenter(d.box0);
    const a = Math.atan2(wy - c.y, wx - c.x);
    let delta = a - (d.angle0 ?? 0);
    if (shift) delta = Math.round(delta / (Math.PI / 12)) * (Math.PI / 12);
    const single = d.resizeItems.length === 1;
    for (let i = 0; i < d.resizeItems.length; i++) {
      const r = d.resizeItems[i]!;
      const a0 = d.itemsAngle0![i]!;
      r.it.angle = a0 + delta;
      if (!single) {
        // Rotate the item's frame center about the box center.
        const fc = frameCenter(r.f);
        const nc = rot(fc.x, fc.y, c.x, c.y, delta);
        r.it.x = nc.x - r.f.w / 2;
        r.it.y = nc.y - r.f.h / 2;
      }
    }
  }

  private handleMask(h: string): { ex: number; ey: number } {
    return {
      ex: h.includes("w") ? -1 : h.includes("e") ? 1 : 0,
      ey: h.includes("n") ? -1 : h.includes("s") ? 1 : 0,
    };
  }

  private handleAt(sx: number, sy: number): string | null {
    const h = this.handleRects.find(h => Math.abs(sx - h.x) <= 6 && Math.abs(sy - h.y) <= 6);
    return h ? h.id : null;
  }

  // ── context menu ────────────────────────────────────────────────────────────

  private openMenu(sx: number, sy: number, wx: number, wy: number): void {
    const hitIt = this.hitAt(wx, wy);
    if (hitIt && !this.selected.has(hitIt.id)) this.selected = new Set([hitIt.id]);
    if (!hitIt) this.selected.clear();
    const sel = this.selectionItems();
    const multi = sel.length > 1;
    const entries: (MenuEntry | "sep")[] = [];
    if (sel.length) {
      entries.push(
        { label: "Copy", key: "Ctrl+C", enabled: true, action: () => this.copySelection(false) },
        { label: "Cut", key: "Ctrl+X", enabled: true, action: () => this.copySelection(true) },
        { label: "Duplicate", key: "Ctrl+D", enabled: true, action: () => this.duplicate() },
        "sep",
        { label: "Bring forward", key: "Ctrl+]", enabled: true, action: () => this.reorder("fwd") },
        { label: "Send backward", key: "Ctrl+[", enabled: true, action: () => this.reorder("bwd") },
        { label: "Bring to front", enabled: true, action: () => this.reorder("front") },
        { label: "Send to back", enabled: true, action: () => this.reorder("back") },
        "sep",
        { label: "Group", key: "Ctrl+G", enabled: multi, action: () => this.group() },
        { label: "Ungroup", key: "Ctrl+Shift+G", enabled: sel.some((i) => i.group), action: () => this.ungroup() },
      );
      if (multi) {
        entries.push("sep",
          { label: "Align left", enabled: true, action: () => this.align("left") },
          { label: "Align center", enabled: true, action: () => this.align("cx") },
          { label: "Align right", enabled: true, action: () => this.align("right") },
          { label: "Align top", enabled: true, action: () => this.align("top") },
          { label: "Align middle", enabled: true, action: () => this.align("cy") },
          { label: "Align bottom", enabled: true, action: () => this.align("bottom") },
          { label: "Distribute horizontally", enabled: sel.length >= 3, action: () => this.distribute("h") },
          { label: "Distribute vertically", enabled: sel.length >= 3, action: () => this.distribute("v") },
        );
      }
      entries.push("sep",
        { label: "Delete", key: "Del", enabled: true, action: () => this.deleteSelection() },
      );
    } else {
      entries.push(
        { label: "Paste", key: "Ctrl+V", enabled: this.clipboard.length > 0, action: () => this.paste() },
        { label: "Select all", key: "Ctrl+A", enabled: this.wb.items.length > 0, action: () => { this.selected = new Set(this.wb.items.map((i) => i.id)); } },
        "sep",
        { label: "Zoom to fit", key: "Shift+1", enabled: this.wb.items.length > 0, action: () => this.zoomToFit() },
        { label: "Reset zoom", key: "Ctrl+0", enabled: true, action: () => this.zoomReset() },
        { label: this.wbGrid ? "Hide grid" : "Show grid", enabled: true, action: () => { this.wb.grid = !this.wbGrid; this.dirty(); } },
        "sep",
        { label: "Export as SVG", enabled: this.wb.items.length > 0, action: () => void this.exportWb("svg") },
        { label: "Export as PNG", enabled: this.wb.items.length > 0, action: () => void this.exportWb("png") },
        { label: "Export as PDF", enabled: this.wb.items.length > 0, action: () => void this.exportWb("pdf") },
      );
    }
    this.menu = { x: sx, y: sy, entries, hover: -1 };
  }

  private menuIndexAt(sy: number): number {
    if (!this.menu || !this.menuRect) return -1;
    let y = this.menuRect.y + 6;
    for (let i = 0; i < this.menu.entries.length; i++) {
      const ent = this.menu.entries[i]!;
      const h = ent === "sep" ? 9 : 24;
      if (sy >= y && sy < y + h) return ent === "sep" ? -1 : i;
      y += h;
    }
    return -1;
  }

  // ── toolbar / zoom / props callbacks ─────────────────────────────────────────

  private onToolbarClick(id: string): void {
    if (id === "lock") { this.toolLocked = !this.toolLocked; return; }
    if (id === "undo") { this.undo(); return; }
    if (id === "redo") { this.redo(); return; }
    if (id === "grid") { this.wb.grid = !this.wbGrid; this.dirty(); return; }
    this.tool = id as Tool;
  }

  private onZoomClick(id: string): void {
    if (id === "zin") this.zoomStep(1.25);
    else if (id === "zout") this.zoomStep(1 / 1.25);
    else if (id === "zlabel") this.zoomReset();
    else if (id === "zfit") this.zoomToFit();
  }

  private zoomStep(k: number): void {
    const z = this.wb.cam.zoom;
    const cx = this.rect.x + this.rect.w / 2, cy = this.rect.y + this.rect.h / 2;
    const wx = this.s2wX(cx), wy = this.s2wY(cy);
    const nz = Math.max(0.1, Math.min(10, z * k));
    this.wb.cam.x = wx - (cx - this.rect.x) / nz;
    this.wb.cam.y = wy - (cy - this.rect.y) / nz;
    this.wb.cam.zoom = nz;
    this.dirty();
  }

  private zoomReset(): void {
    this.zoomStep(1 / this.wb.cam.zoom);
  }

  private zoomTo(box: Frame | null): void {
    if (!box || box.w < 1 || box.h < 1) { this.zoomReset(); return; }
    const pad = 80;
    const z = Math.max(0.1, Math.min(10,
      Math.min((this.rect.w - pad * 2) / box.w, (this.rect.h - pad * 2) / box.h)));
    this.wb.cam.zoom = z;
    this.wb.cam.x = box.x + box.w / 2 - (this.rect.w / z) / 2;
    this.wb.cam.y = box.y + box.h / 2 - (this.rect.h / z) / 2;
    this.dirty();
  }

  private zoomToFit(): void {
    if (!this.wb.items.length) { this.zoomReset(); return; }
    this.zoomTo(combineAABBs(this.wb.items.map((i) => this.aabbOf(i))));
  }

  private zoomToSelection(): void {
    const sel = this.selectionItems();
    if (!sel.length) { this.zoomToFit(); return; }
    this.zoomTo(combineAABBs(sel.map((i) => this.aabbOf(i))));
  }

  /** Property-panel apply: updates the selection AND the draw defaults. */
  private applyProp(id: string, value: string): void {
    const sel = this.selectionItems();
    const pushable = sel.length > 0;
    if (pushable) this.pushUndo();
    const forEach = (pred: (i: WbItem) => boolean, fn: (i: WbItem) => void) => {
      sel.forEach(it => { if (pred(it)) fn(it); });
    };
    switch (id) {
      case "stroke": {
        const v = Number(value);
        this.style.color = v;
        forEach(() => true, (it) => { it.color = v; });
        break;
      }
      case "fill": {
        const v = Number(value);
        this.style.fill = v;
        forEach((i) => CLOSED_KINDS.includes(i.kind), (it) => { it.fill = v; });
        break;
      }
      case "fillStyle": {
        this.style.fillStyle = value as WbItem["fillStyle"];
        forEach((i) => i.kind !== "sticky" && CLOSED_KINDS.includes(i.kind),
          (it) => { it.fillStyle = value as WbItem["fillStyle"]; });
        break;
      }
      case "sw": {
        const v = Number(value);
        this.style.size = v;
        forEach((i) => i.kind !== "text" && i.kind !== "sticky", (it) => { it.size = v; });
        break;
      }
      case "ss": {
        this.style.strokeStyle = value as WbItem["strokeStyle"];
        forEach((i) => i.kind !== "text", (it) => { it.strokeStyle = value as WbItem["strokeStyle"]; });
        break;
      }
      case "rough": {
        const v = Number(value);
        this.style.roughness = v;
        forEach((i) => i.kind !== "text", (it) => { it.roughness = v; });
        break;
      }
      case "edge": {
        const v = value === "round";
        this.style.round = v;
        forEach((i) => i.kind === "rect" || i.kind === "line" || i.kind === "arrow", (it) => { it.round = v; });
        break;
      }
      case "font": {
        this.style.font = value as WbItem["font"];
        forEach((i) => i.kind === "text" || i.kind === "sticky" || i.boundText !== undefined,
          (it) => { it.font = value as WbItem["font"]; });
        break;
      }
      case "fs": {
        const v = Number(value);
        this.style.fontSize = v;
        forEach((i) => i.kind === "text" || i.kind === "sticky" || i.boundText !== undefined, (it) => {
          if (it.kind === "text" || it.kind === "sticky") {
            it.size = v;
            if (it.kind === "text") { const f = textFrame(it, this.measure); it.w = f.w; it.h = f.h; }
          } else {
            it.fontSize = v;
          }
        });
        break;
      }
      case "ahStart": {
        const heads: WbArrowhead[] = ["none", "arrow", "triangle", "dot"];
        forEach((i) => LINEAR_KINDS.includes(i.kind), (it) => {
          const cur = heads.indexOf(it.startArrow ?? "none");
          it.startArrow = heads[(cur + 1) % heads.length];
        });
        break;
      }
      case "ahEnd": {
        const heads: WbArrowhead[] = ["none", "arrow", "triangle", "dot"];
        forEach((i) => LINEAR_KINDS.includes(i.kind), (it) => {
          const cur = heads.indexOf(it.endArrow ?? "arrow");
          it.endArrow = heads[(cur + 1) % heads.length];
          this.style.endArrow = it.endArrow;
        });
        break;
      }
      case "act": {
        if (value === "dup") this.duplicate();
        else if (value === "del") this.deleteSelection();
        else if (value === "fwd") this.reorder("fwd");
        else if (value === "bwd") this.reorder("bwd");
        else if (value === "front") this.reorder("front");
        else if (value === "back") this.reorder("back");
        else if (value === "grp") this.group();
        else if (value === "ungrp") this.ungroup();
        else if (value.startsWith("al")) this.align(value.slice(2) as "left" | "cx" | "right" | "top" | "cy" | "bottom");
        else if (value === "dh") this.distribute("h");
        else if (value === "dv") this.distribute("v");
        return; // actions manage their own undo
      }
    }
    if (pushable) this.dirty();
  }

  private onPropClick(id: string, value: string, r: UiRect, sx: number): void {
    if (id === "opacity") {
      // Begin a slider drag.
      this.draft = {
        kind: "slider", sliderId: "opacity", startWX: 0, startWY: 0,
        sx0: r.x, sy0: r.y, moved: false, items0: this.cloneItems(),
      };
      this.sliderMove(sx);
      return;
    }
    this.applyProp(id, value);
  }

  private sliderMove(sx: number): void {
    const d = this.draft;
    if (!d || d.kind !== "slider") return;
    const trackW = 96;
    const v = Math.max(0.05, Math.min(1, (sx - d.sx0) / trackW));
    const sel = this.selectionItems();
    if (sel.length) {
      sel.forEach(it => { it.opacity = Math.round(v * 100) / 100; });
    }
    this.style.opacity = Math.round(v * 100) / 100;
    this.draftMovedDirty();
  }

  private draftMovedDirty(): void {
    if (this.draft) this.draft.moved = true;
    this.dirty();
  }

  // ── render ─────────────────────────────────────────────────────────────────

  private t(): ReturnType<typeof tokens> {
    return tokens(store.getState().theme);
  }

  update(dt: number): void {
    // Wall-clock delta — see EditorSurface.tick (sparse renderOnce service).
    const nowMs = performance.now();
    const rdt = this.lastTickMs > 0 ? Math.min(0.5, (nowMs - this.lastTickMs) / 1000) : dt;
    this.lastTickMs = nowMs;
    this.time += rdt;
    this.blinkT += rdt;
    const phase = Math.floor(this.blinkT * 2);
    if (phase !== this.blinkPhase) {
      this.blinkPhase = phase;
      if (this.wantsBlink()) this.ctx.requestFrame();
    }
  }

  hasContent(): boolean {
    return this.active && this.cache.ready && !this.disposed;
  }

  /** Engine damage-gate poll (damageOnly): framePending covers content
   *  mutations; the toast fade rides animating() and lastAnim lands its
   *  settle frame. */
  takeDirty(): boolean {
    const a = this.animating();
    const d = this.framePending || a || this.lastAnim;
    this.framePending = false;
    this.lastAnim = a;
    return d;
  }

  /** The toast fade (~2.7s) is the only time-driven visual — everything else
   *  repaints on input wakes. */
  animating(): boolean {
    return this.active && !this.disposed && this.toast !== null && this.time - this.toast.t < 3;
  }

  /** A blinking edit caret is visible — blink flips mark a frame via
   *  ctx.requestFrame() (see update). */
  wantsBlink(): boolean {
    return this.active && this.editing !== null && !this.disposed;
  }

  render(pass: GPURenderPassEncoder, surfaceW: number, surfaceH: number): void {
    if (this.rect.w <= 0) return;
    const p = this.pass;
    const t = this.t();
    const z = this.wb.cam.zoom;
    const pt = this.painter();
    p.begin();

    const ranges: { start: number; end: number; scissor?: [number, number, number, number] }[] =
      [{ start: 0, end: -1, scissor: [this.rect.x, this.rect.y, this.rect.w, this.rect.h] }];

    p.rect(this.rect.x, this.rect.y, this.rect.w, this.rect.h, hex(t.bg));

    // Dot grid — finer than before; adaptive level-of-detail so dots never
    // moiré when zoomed out. Hidden in exports.
    if (this.wbGrid && !this.exportClean) {
      let spacing = 22 * z;
      for (; spacing < 9; spacing *= 4) {} // drop to a coarser level
      if (spacing >= 9) {
        const dot = hex(t.line);
        const s = Math.max(1.5, Math.min(2.5, 1.6 * Math.sqrt(z)));
        const gx0 = this.rect.x - (((this.wb.cam.x * z) % spacing) + spacing) % spacing;
        const gy0 = this.rect.y - (((this.wb.cam.y * z) % spacing) + spacing) % spacing;
        for (let gy = gy0; gy < this.rect.y + this.rect.h; gy += spacing) {
          for (let gx = gx0; gx < this.rect.x + this.rect.w; gx += spacing) {
            p.roundedRect(gx - s / 2, gy - s / 2, s, s, s / 2, dot);
          }
        }
      }
    }

    // Items.
    this.wb.items.forEach(it => {
      pt.drawItem(it, this.wb.items, {
        edit: this.editing?.itemId === it.id
          ? { field: this.editing.field, caret: this.editing.caret, anchor: this.editing.anchor, blinkOn: this.blinkT % 1 < 0.55 }
          : undefined,
      });
    });
    if (!this.exportClean) {
      // Draft previews.
      if (this.draft?.item) {
        pt.drawItem(this.draft.item, this.wb.items, { isDraft: true });
        if (this.draft.kind === "linear") this.drawLinearGhost(pt);
      }
      // Snap guides.
      if (this.snapGuide) {
        const g = hex(t.accent);
        if (this.snapGuide.gx !== null) {
          const x = this.w2sX(this.snapGuide.gx);
          p.rect(x - 0.5, this.rect.y, 1, this.rect.h, withAlpha(g, 0.6));
        }
        if (this.snapGuide.gy !== null) {
          const y = this.w2sY(this.snapGuide.gy);
          p.rect(this.rect.x, y - 0.5, this.rect.w, 1, withAlpha(g, 0.6));
        }
      }
      this.drawConnectors(pt, t);
      this.drawSelection(pt, t);
      // Eraser cursor.
      if (this.tool === "eraser" && !this.draft) {
        p.roundedRect(this.cursor.x - 7, this.cursor.y - 7, 14, 14, 7, [1, 1, 1, 0.08]);
        const c = hex(t.danger);
        p.ellipse(this.cursor.x - 7, this.cursor.y - 7, 14, 14, [c[0], c[1], c[2], 0.35]);
      }
    }
    ranges[0]!.end = p.quadCount;

    // Floating UI (unclipped) — suppressed entirely while exporting.
    if (!this.exportClean) {
      ranges.push({ start: p.quadCount, end: -1 });
      this.drawToolbar(pt, t);
      this.drawZoomIsland(pt, t);
      this.drawPropsPanel(pt, t);
      if (this.menu) this.drawMenu(pt, t);
      if (this.toast) this.drawToast(pt, t);
      ranges[ranges.length - 1]!.end = p.quadCount;
    }

    p.renderRanges(pass, surfaceW, surfaceH, this.atlas, this.time, ranges, this.dpr);
  }

  /** Ghost line tracking the cursor while a multi-point element is open. */
  private drawLinearGhost(pt: WbPainter): void {
    const d = this.draft;
    if (!d?.item?.points || d.item.points.length < 2) return;
    const it = d.item;
    const p = it.points!;
    const lx = it.x + p[p.length - 2]!, ly = it.y + p[p.length - 1]!;
    const end = this.linearPoint(this.s2wX(this.cursor.x), this.s2wY(this.cursor.y), false);
    const [x0, y0] = pt.s(lx, ly);
    const [x1, y1] = pt.s(end.x, end.y);
    const color = withAlpha(STROKE_COLORS[it.color % STROKE_COLORS.length]!, 0.55);
    pt.strokePath([x0, y0, x1, y1], Math.max(0.8, it.size * this.wb.cam.zoom * 0.55), color, [8, 6]);
  }

  /** Port dots on the hovered connectable shape + a bind-target highlight
   *  while dragging a connector or endpoint. */
  private drawConnectors(pt: WbPainter, t: ReturnType<typeof tokens>): void {
    const p = this.pass;
    const accent = hex(t.accent);
    const d = this.draft;

    // Highlight the shape a dragged endpoint/connector would bind to.
    if ((d?.kind === "vertex" || d?.kind === "linear") && d.item &&
        (d.item.kind === "arrow" || d.item.kind === "line")) {
      const host = this.bindableHostAt(this.s2wX(this.cursor.x), this.s2wY(this.cursor.y), d.item);
      if (host) {
        const f = frameOf(host, this.measure);
        const c = frameCenter(f);
        const [scx, scy] = pt.s(c.x, c.y);
        const prev = p.rotation;
        p.rotation = host.angle ? { angle: host.angle, x: scx, y: scy } : null;
        const [x0, y0] = pt.s(f.x - 5 / this.wb.cam.zoom, f.y - 5 / this.wb.cam.zoom);
        const [x1, y1] = pt.s(f.x + f.w + 5 / this.wb.cam.zoom, f.y + f.h + 5 / this.wb.cam.zoom);
        pt.strokePath([x0, y0, x1, y0, x1, y1, x0, y1, x0, y0], 1.5, withAlpha(accent, 0.85), [5, 4]);
        p.rotation = prev;
      }
    }

    // Idle ports on the hovered shape — visible affordance for "drag to connect".
    if (this.editing || d || this.menu) return;
    if (this.tool !== "select" && this.tool !== "arrow" && this.tool !== "line") return;
    const host = this.portHostAtCursor();
    if (!host) return;
    this.portsOf(host).forEach(port => {
      const [px, py] = pt.s(port.x, port.y);
      p.ellipse(px - 5.5, py - 5.5, 11, 11, withAlpha(accent, 0.25));
      p.ellipse(px - 4, py - 4, 8, 8, accent);
      p.ellipse(px - 2.5, py - 2.5, 5, 5, [1, 1, 1, 0.95]);
    });
  }

  // ── selection chrome ─────────────────────────────────────────────────────────

  private drawSelection(pt: WbPainter, t: ReturnType<typeof tokens>): void {
    const p = this.pass;
    const box = this.selectionBox();
    this.handleRects = [];
    const accent = hex(t.accent);
    if (box) {
      const f = box.f;
      const pad = 5 / this.wb.cam.zoom;
      const c = frameCenter(f);
      const [scx, scy] = pt.s(c.x, c.y);
      const prevRot = p.rotation;
      p.rotation = box.angle ? { angle: box.angle, x: scx, y: scy } : null;
      const [x0, y0] = pt.s(f.x - pad, f.y - pad);
      const [x1, y1] = pt.s(f.x + f.w + pad, f.y + f.h + pad);
      // Thin outline (4 rects for crisp edges).
      p.rect(x0, y0, x1 - x0, 1.2, accent);
      p.rect(x0, y1 - 1.2, x1 - x0, 1.2, accent);
      p.rect(x0, y0, 1.2, y1 - y0, accent);
      p.rect(x1 - 1.2, y0, 1.2, y1 - y0, accent);
      // Handles (corners + edges) in the same rotated frame.
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      const spots: { id: string; x: number; y: number }[] = [
        { id: "nw", x: x0, y: y0 }, { id: "n", x: mx, y: y0 }, { id: "ne", x: x1, y: y0 },
        { id: "e", x: x1, y: my }, { id: "se", x: x1, y: y1 }, { id: "s", x: mx, y: y1 },
        { id: "sw", x: x0, y: y1 }, { id: "w", x: x0, y: my },
      ];
      // Rotate-handle anchor above top-center.
      const rx = mx, ry = y0 - 24;
      p.capsule(mx, y0, rx, ry + 5, 0.8, withAlpha(accent, 0.8));
      spots.forEach(s => {
        p.roundedRect(s.x - 4, s.y - 4, 8, 8, 2, [1, 1, 1, 0.95]);
        const oc = withAlpha(accent, 0.9);
        p.rect(s.x - 4, s.y - 4, 8, 1, oc); p.rect(s.x - 4, s.y + 3, 8, 1, oc);
        p.rect(s.x - 4, s.y - 4, 1, 8, oc); p.rect(s.x + 3, s.y - 4, 1, 8, oc);
      });
      p.roundedRect(rx - 5, ry - 5, 10, 10, 5, [1, 1, 1, 0.95]);
      p.ellipse(rx - 3, ry - 3, 6, 6, accent);
      // Handle hit positions must be in the UNrotated screen frame — the
      // shader already rotates them visually; hit-test needs their drawn pos.
      const unrot = (x: number, y: number): { x: number; y: number } =>
        box.angle ? rot(x, y, scx, scy, box.angle) : { x, y };
      spots.forEach(s => {
        const u = unrot(s.x, s.y);
        this.handleRects.push({ id: s.id, x: u.x, y: u.y });
      });
      const ur = unrot(rx, ry);
      this.handleRects.push({ id: "rot", x: ur.x, y: ur.y });
      p.rotation = prevRot;
      // Vertex handles on a single selected line/arrow — endpoint circles
      // drag to reshape/rebind; smaller midpoint circles insert a bend.
      this.vertexHandles().forEach(v => {
        const r = v.mid ? 4 : 5.5;
        p.ellipse(v.x - r, v.y - r, r * 2, r * 2, accent);
        p.ellipse(v.x - r + 2, v.y - r + 2, r * 2 - 4, r * 2 - 4, [1, 1, 1, 0.95]);
      });
    }
    // Marquee.
    if (this.draft?.kind === "marquee" && this.draft.moved) {
      const d = this.draft;
      const x0 = Math.min(d.sx0, this.cursor.x), x1 = Math.max(d.sx0, this.cursor.x);
      const y0 = Math.min(d.sy0, this.cursor.y), y1 = Math.max(d.sy0, this.cursor.y);
      p.rect(x0, y0, x1 - x0, y1 - y0, hex(t.selSoft));
      p.rect(x0, y0, x1 - x0, 1, accent); p.rect(x0, y1 - 1, x1 - x0, 1, accent);
      p.rect(x0, y0, 1, y1 - y0, accent); p.rect(x1 - 1, y0, 1, y1 - y0, accent);
    }
  }

  // ── toolbar / zoom islands ─────────────────────────────────────────────────────

  private island(x: number, y: number, w: number, h: number, t: ReturnType<typeof tokens>): void {
    const p = this.pass;
    p.roundedRect(x + 1.5, y + 3, w, h, 10, [0, 0, 0, 0.4]);
    p.roundedRect(x, y, w, h, 10, hex(t.bgElev));
    const oc = hex(t.line);
    p.rect(x, y, w, 1, oc); p.rect(x, y + h - 1, w, 1, oc);
    p.rect(x, y, 1, h, oc); p.rect(x + w - 1, y, 1, h, oc);
  }

  private drawToolbar(pt: WbPainter, t: ReturnType<typeof tokens>): void {
    const p = this.pass;
    const btn = 30, pad = 5;
    const toolsW = TOOLS.length * (btn + 2);
    const w = pad * 2 + 24 + 10 + toolsW + 10 + 2 * (btn + 2) + 10 + (btn + 2);
    const x = this.rect.x + (this.rect.w - w) / 2;
    const y = this.rect.y + 8;
    this.island(x, y, w, 42, t);
    this.toolbarRect = { x, y, w, h: 42 };
    this.toolRects = [];

    let cx = x + pad;
    // Lock toggle.
    this.toolBtn(cx, y + 6, btn, "lock", this.toolLocked, t, pt);
    cx += btn + 2;
    cx = this.divider(cx, y, t);
    TOOLS.forEach(tl => {
      this.toolBtn(cx, y + 6, btn, tl.id, this.tool === tl.id, t, pt, tl.num);
      cx += btn + 2;
    });
    cx = this.divider(cx, y, t);
    this.toolBtn(cx, y + 6, btn, "undo", false, t, pt); cx += btn + 2;
    this.toolBtn(cx, y + 6, btn, "redo", false, t, pt); cx += btn + 2;
    cx = this.divider(cx, y, t);
    this.toolBtn(cx, y + 6, btn, "grid", this.wbGrid, t, pt);

    // Tooltip on hover.
    const hov = this.toolRects.find((tr) =>
      this.cursor.x >= tr.r.x && this.cursor.x <= tr.r.x + tr.r.w &&
      this.cursor.y >= tr.r.y && this.cursor.y <= tr.r.y + tr.r.h);
    if (hov && TOOL_TIPS[hov.id]) this.drawTooltip(TOOL_TIPS[hov.id]!, hov.r.x + hov.r.w / 2, y + 46, pt, t);
  }

  private drawTooltip(label: string, cx: number, y: number,
    pt: WbPainter, t: ReturnType<typeof tokens>): void {
    const p = this.pass;
    const tw = pt.advance("inter:400:normal", 11, label);
    const w = tw + 16, h = 22;
    p.roundedRect(cx - w / 2, y, w, h, 6, hex(t.bgElev));
    const oc = hex(t.line);
    p.rect(cx - w / 2, y, w, 1, oc); p.rect(cx - w / 2, y + h - 1, w, 1, oc);
    p.rect(cx - w / 2, y, 1, h, oc); p.rect(cx + w / 2 - 1, y, 1, h, oc);
    this.pt(cx - tw / 2, y + 5, 11, label, hex(t.text), pt);
  }

  private divider(cx: number, y: number, t: ReturnType<typeof tokens>): number {
    this.pass.rect(cx + 4, y + 10, 1, 22, hex(t.line));
    return cx + 10;
  }

  private toolBtn(x: number, y: number, w: number, id: string, active: boolean,
    t: ReturnType<typeof tokens>, pt: WbPainter, num?: string): void {
    const p = this.pass;
    if (active) p.roundedRect(x, y, w, 30, 7, hex(t.accentSoft));
    this.drawToolIcon(id, x, y, w, 30, hex(active ? t.accentText : t.textDim), pt, t);
    if (num) this.pt(x + w - 9, y + 19, 8, num, hex(t.textFaint), pt);
    this.toolRects.push({ id, r: { x, y, w, h: 30 } });
  }

  private pt(x: number, y: number, size: number, str: string, color: Rgba, pt: WbPainter): void {
    pt.text(x, y, "inter:400:normal", size, str, color);
  }

  /** Bottom-center status pill (export confirmations, etc.). */
  private drawToast(pt: WbPainter, t: ReturnType<typeof tokens>): void {
    const p = this.pass;
    const toast = this.toast!;
    const age = this.time - toast.t;
    const a = Math.max(0, Math.min(1, 3 - age / 0.9));
    if (a <= 0) return;
    const w = this.measure("inter", 12, toast.text) + 26;
    const x = this.rect.x + (this.rect.w - w) / 2;
    const y = this.rect.y + this.rect.h - 52;
    p.roundedRect(x, y, w, 26, 13, [0, 0, 0, 0.55 * a]);
    this.pt(x + 13, y + 8, 12, toast.text, [1, 1, 1, 0.92 * a], pt);
  }

  // ── export ──────────────────────────────────────────────────────────────────

  private exportDir(): string {
    const d = join(workspaceDir(), "exports");
    mkdirSync(d, { recursive: true });
    return d;
  }

  private showToast(text: string): void {
    this.toast = { text, t: this.time };
    this.dirty();
  }

  /** Export the board: SVG (vector), PNG or PDF (clean fit-to-content frame
   *  read back from the surface, cropped to the canvas). */
  private async exportWb(fmt: "svg" | "png" | "pdf"): Promise<void> {
    const wb = this.wb;
    if (!wb.items.length) { this.showToast("Nothing to export"); return; }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const base = join(this.exportDir(), `whiteboard-${stamp}`);
    try {
      if (fmt === "svg") {
        writeFileSync(`${base}.svg`, wbSvg(wb, this.measure));
        this.showToast(`Exported ${base}.svg`);
        return;
      }
      const host = getNativeHost() as {
        surface?: {
          width: number; height: number;
          captureNextFrame?: (ms?: number) => Promise<Uint8Array | null>;
        };
      } | null;
      const surf = host?.surface;
      if (!surf?.captureNextFrame) { this.showToast("Export needs a native surface"); return; }
      // Fit content into the canvas for the captured frame.
      const b = wbBounds(wb.items, this.measure);
      const cam0 = { x: wb.cam.x, y: wb.cam.y, zoom: wb.cam.zoom };
      const z = Math.max(0.1, Math.min(4, Math.min(this.rect.w / b.w, this.rect.h / b.h)));
      wb.cam.zoom = z;
      wb.cam.x = b.x + b.w / 2 - this.rect.w / (2 * z);
      wb.cam.y = b.y + b.h / 2 - this.rect.h / (2 * z);
      this.exportClean = true;
      this.dirty();
      const frame = await surf.captureNextFrame(2500).catch(() => null);
      wb.cam.x = cam0.x; wb.cam.y = cam0.y; wb.cam.zoom = cam0.zoom;
      this.exportClean = false;
      this.dirty();
      if (!frame || frame.length < surf.width * surf.height * 4) {
        this.showToast("Export failed: no frame");
        return;
      }
      const img = cropRgba({ w: surf.width, h: surf.height, data: frame },
        this.rect.x, this.rect.y, this.rect.w, this.rect.h);
      if (fmt === "png") {
        writeFileSync(`${base}.png`, encodePNG(img.w, img.h, img.data));
        this.showToast(`Exported ${base}.png`);
      } else {
        writeFileSync(`${base}.pdf`, pdfFromRgba(img));
        this.showToast(`Exported ${base}.pdf`);
      }
    } catch (err) {
      this.exportClean = false;
      this.showToast(`Export failed: ${String(err).slice(0, 80)}`);
    }
  }

  private drawZoomIsland(pt: WbPainter, t: ReturnType<typeof tokens>): void {
    const p = this.pass;
    const w = 132, h = 32;
    const x = this.rect.x + 10, y = this.rect.y + this.rect.h - h - 10;
    this.island(x, y, w, h, t);
    this.zoomRects = [
      { id: "zout", r: { x: x + 4, y: y + 3, w: 26, h: 26 } },
      { id: "zlabel", r: { x: x + 32, y: y + 3, w: 52, h: 26 } },
      { id: "zin", r: { x: x + 86, y: y + 3, w: 26, h: 26 } },
    ];
    const dim = hex(t.textDim);
    p.rect(x + 10, y + 15, 12, 1.6, dim);
    p.rect(x + 93, y + 15, 12, 1.6, dim); p.rect(x + 98.2, y + 10, 1.6, 11, dim);
    const pct = `${Math.round(this.wb.cam.zoom * 100)}%`;
    const tw = pt.advance("inter:400:normal", 11, pct);
    this.pt(x + 32 + (52 - tw) / 2, y + 9, 11, pct, dim, pt);
    // Fit button to the right.
    this.island(x + w + 8, y, 62, h, t);
    this.zoomRects.push({ id: "zfit", r: { x: x + w + 8, y, w: 62, h } });
    const fw = pt.advance("inter:400:normal", 11, "Fit");
    this.pt(x + w + 8 + (62 - fw) / 2, y + 9, 11, "Fit", dim, pt);
    const hov = this.zoomRects.find((zr) =>
      this.cursor.x >= zr.r.x && this.cursor.x <= zr.r.x + zr.r.w &&
      this.cursor.y >= zr.r.y && this.cursor.y <= zr.r.y + zr.r.h);
    if (hov && TOOL_TIPS[hov.id]) this.drawTooltip(TOOL_TIPS[hov.id]!, hov.r.x + hov.r.w / 2, y - 26, pt, t);
  }

  // ── props panel ──────────────────────────────────────────────────────────────

  private drawPropsPanel(pt: WbPainter, t: ReturnType<typeof tokens>): void {
    const p = this.pass;
    const sel = this.selectionItems();
    const drawTool = this.tool !== "select" && this.tool !== "hand" && this.tool !== "eraser";
    if (sel.length === 0 && !drawTool) { this.panelRect = null; this.propRects = []; return; }
    const hasClosed = sel.some((i) => CLOSED_KINDS.includes(i.kind)) ||
      ["rect", "diamond", "ellipse", "sticky"].includes(this.tool);
    const hasText = sel.some((i) => i.kind === "text" || i.kind === "sticky" || i.boundText !== undefined) ||
      this.tool === "text" || this.tool === "sticky";
    const hasLinear = sel.some((i) => LINEAR_KINDS.includes(i.kind)) ||
      this.tool === "arrow" || this.tool === "line";
    const hasStrokeable = sel.some((i) => i.kind !== "text") ||
      ["pen", "rect", "diamond", "ellipse", "arrow", "line"].includes(this.tool);

    const rows: { label: string; h: number; draw: (y: number) => void }[] = [];
    const cur = sel.length === 1 ? sel[0]! : null;

    const row = (label: string, h: number, draw: (y: number) => void) => rows.push({ label, h, draw });
    const W = 196, x = this.rect.x + 10;
    const segW = 26;

    const segRow = (label: string, id: string,
      opts: { v: string; icon: (x: number, y: number, c: Rgba) => void; cur: boolean }[]): number => {
      row(label, 24, (y) => {
        let bx = x + 64;
        opts.forEach(o => {
          if (o.cur) p.roundedRect(bx, y, segW, 20, 5, hex(t.accentSoft));
          o.icon(bx + segW / 2, y + 10, hex(o.cur ? t.accentText : t.textDim));
          this.propRects.push({ id, value: o.v, r: { x: bx, y, w: segW, h: 20 } });
          bx += segW + 2;
        });
      });
      return 24;
    };

    // Stroke swatches.
    row("Stroke", 24, (y) => {
      let bx = x + 64;
      for (let i = 0; i < STROKE_COLORS.length; i++) {
        const curC = (sel.length ? sel.every((it) => it.color === i) : this.style.color === i);
        if (curC) p.roundedRect(bx - 2, y - 1, 20, 20, 6, hex(t.accentSoft));
        p.roundedRect(bx + 1, y + 2, 14, 14, 7, STROKE_COLORS[i]!);
        this.propRects.push({ id: "stroke", value: String(i), r: { x: bx - 2, y: y - 1, w: 20, h: 20 } });
        bx += 21;
      }
    });
    if (hasClosed) {
      row("Fill", 24, (y) => {
        let bx = x + 64;
        // Transparent swatch.
        const noneCur = sel.length ? sel.every((it) => it.fill < 0 || !CLOSED_KINDS.includes(it.kind)) : this.style.fill < 0;
        if (noneCur) p.roundedRect(bx - 2, y - 1, 20, 20, 6, hex(t.accentSoft));
        p.roundedRect(bx + 1, y + 2, 14, 14, 7, [1, 1, 1, 0.10]);
        p.capsule(bx + 2, y + 15, bx + 14, y + 3, 0.8, hex(t.danger));
        this.propRects.push({ id: "fill", value: "-1", r: { x: bx - 2, y: y - 1, w: 20, h: 20 } });
        bx += 21;
        for (let i = 0; i < FILL_COLORS.length; i++) {
          const curC = sel.length ? sel.every((it) => it.fill === i) : this.style.fill === i;
          if (curC) p.roundedRect(bx - 2, y - 1, 20, 20, 6, hex(t.accentSoft));
          p.roundedRect(bx + 1, y + 2, 14, 14, 7, FILL_COLORS[i]!);
          p.roundedRect(bx + 1, y + 2, 14, 14, 7, [0, 0, 0, 0]);
          this.propRects.push({ id: "fill", value: String(i), r: { x: bx - 2, y: y - 1, w: 20, h: 20 } });
          bx += 21;
        }
      });
      segRow("FillStyle", "fillStyle", [
        { v: "hachure", cur: sel.length ? sel.some((i) => i.fillStyle === "hachure") : this.style.fillStyle === "hachure",
          icon: (ix, iy, c) => { pt.strokePath([ix - 6, iy + 5, ix + 6, iy - 5], 1, c); pt.strokePath([ix - 2, iy + 5, ix + 6, iy - 1], 1, c); } },
        { v: "cross", cur: sel.length ? sel.some((i) => i.fillStyle === "cross") : this.style.fillStyle === "cross",
          icon: (ix, iy, c) => { pt.strokePath([ix - 6, iy + 5, ix + 6, iy - 5], 1, c); pt.strokePath([ix - 6, iy - 5, ix + 6, iy + 5], 1, c); } },
        { v: "solid", cur: sel.length ? sel.some((i) => i.fillStyle === "solid") : this.style.fillStyle === "solid",
          icon: (ix, iy, c) => { p.roundedRect(ix - 6, iy - 5, 12, 10, 2, c); } },
      ]);
    }
    if (hasStrokeable) {
      segRow("SW", "sw", [
        { v: "1.5", cur: (cur?.size ?? this.style.size) <= 1.7,
          icon: (ix, iy, c) => pt.strokePath([ix - 8, iy, ix + 8, iy], 0.9, c) },
        { v: "2.5", cur: (cur?.size ?? this.style.size) > 1.7 && (cur?.size ?? this.style.size) < 3.2,
          icon: (ix, iy, c) => pt.strokePath([ix - 8, iy, ix + 8, iy], 1.6, c) },
        { v: "4", cur: (cur?.size ?? this.style.size) >= 3.2,
          icon: (ix, iy, c) => pt.strokePath([ix - 8, iy, ix + 8, iy], 2.6, c) },
      ]);
      segRow("Style", "ss", [
        { v: "solid", cur: (cur?.strokeStyle ?? this.style.strokeStyle) === "solid",
          icon: (ix, iy, c) => pt.strokePath([ix - 8, iy, ix + 8, iy], 1.2, c) },
        { v: "dashed", cur: (cur?.strokeStyle ?? this.style.strokeStyle) === "dashed",
          icon: (ix, iy, c) => pt.strokePath([ix - 8, iy, ix + 8, iy], 1.2, c, [4, 3]) },
        { v: "dotted", cur: (cur?.strokeStyle ?? this.style.strokeStyle) === "dotted",
          icon: (ix, iy, c) => pt.strokePath([ix - 8, iy, ix + 8, iy], 1.4, c, "dot") },
      ]);
      segRow("Sloppy", "rough", [
        { v: "0", cur: (cur?.roughness ?? this.style.roughness) === 0,
          icon: (ix, iy, c) => pt.strokePath([ix - 8, iy, ix + 8, iy], 1.2, c) },
        { v: "1", cur: (cur?.roughness ?? this.style.roughness) === 1,
          icon: (ix, iy, c) => pt.strokePath([ix - 8, iy, ix - 4, iy - 2, ix, iy + 2, ix + 4, iy - 2, ix + 8, iy], 1.2, c) },
        { v: "2", cur: (cur?.roughness ?? this.style.roughness) === 2,
          icon: (ix, iy, c) => { pt.strokePath([ix - 8, iy - 1, ix - 5, iy + 2, ix - 2, iy - 3, ix + 1, iy + 3, ix + 4, iy - 3, ix + 7, iy + 2, ix + 8, iy], 1.2, c); } },
      ]);
      segRow("Edges", "edge", [
        { v: "sharp", cur: !(cur?.round ?? this.style.round),
          icon: (ix, iy, c) => pt.strokePath([ix - 6, iy + 5, ix - 6, iy - 5, ix + 7, iy - 5], 1.1, c) },
        { v: "round", cur: (cur?.round ?? this.style.round),
          icon: (ix, iy, c) => pt.strokePath([ix - 6, iy + 5, ix - 6, iy - 2, ix - 5, iy - 5, ix + 7, iy - 5], 1.1, c) },
      ]);
    }
    // Opacity slider.
    {
      const v = sel.length ? sel[0]!.opacity : this.style.opacity;
      row("Opacity", 24, (y) => {
        const tx = x + 64, tw = 96;
        p.roundedRect(tx, y + 8, tw, 4, 2, hex(t.bgHover));
        p.roundedRect(tx, y + 8, tw * v, 4, 2, hex(t.accent));
        p.roundedRect(tx + tw * v - 5, y + 4, 10, 12, 5, [1, 1, 1, 0.9]);
        const pct = `${Math.round(v * 100)}`;
        this.pt(tx + tw + 6, y + 5, 10, pct, hex(t.textDim), pt);
        this.propRects.push({ id: "opacity", value: "", r: { x: tx - 4, y, w: tw + 8, h: 20 } });
      });
    }
    if (hasText) {
      segRow("Font", "font", [
        { v: "hand", cur: (cur?.font ?? this.style.font) === "hand",
          icon: (ix, iy, c) => pt.text(ix - pt.advance(faceFor("hand"), 13, "Aa") / 2, iy - 6, faceFor("hand"), 13, "Aa", c) },
        { v: "inter", cur: (cur?.font ?? this.style.font) === "inter",
          icon: (ix, iy, c) => pt.text(ix - pt.advance(faceFor("inter"), 12, "Aa") / 2, iy - 6, faceFor("inter"), 12, "Aa", c) },
        { v: "mono", cur: (cur?.font ?? this.style.font) === "mono",
          icon: (ix, iy, c) => pt.text(ix - pt.advance(faceFor("mono"), 12, "Aa") / 2, iy - 6, faceFor("mono"), 12, "Aa", c) },
      ]);
      segRow("Size", "fs", FONT_SIZES.map((s, i) => ({
        v: String(s),
        cur: Math.abs(((cur && (cur.kind === "text" || cur.kind === "sticky" ? cur.size : cur.fontSize ?? this.style.fontSize)) ?? this.style.fontSize) - s) < 2,
        icon: (ix: number, iy: number, c: Rgba) =>
          this.pt(ix - 4, iy - 5, 9 + i * 1.5, ["S", "M", "L", "X"][i]!, c, pt),
      })));
    }
    if (hasLinear) {
      row("Heads", 24, (y) => {
        const start = cur?.startArrow ?? "none";
        const end = cur?.endArrow ?? this.style.endArrow;
        let bx = x + 64;
        const headBtn = (id: string, cur: string, dir: 1 | -1) => {
          p.roundedRect(bx, y, 40, 20, 5, hex(t.bgHover));
          const c = hex(t.textDim);
          const tipX = dir === 1 ? bx + 32 : bx + 8;
          const tailX = dir === 1 ? bx + 8 : bx + 32;
          const midY = y + 10;
          pt.strokePath([tailX, midY, tipX, midY], 1.2, c);
          if (cur === "arrow") pt.strokePath([tipX - dir * 7, midY - 4, tipX, midY, tipX - dir * 7, midY + 4], 1.2, c);
          else if (cur === "triangle") pt.fillPoly([tipX, midY, tipX - dir * 7, midY - 4, tipX - dir * 7, midY + 4], c);
          else if (cur === "dot") p.ellipse(tipX - 2.5, midY - 2.5, 5, 5, c);
          this.propRects.push({ id, value: "", r: { x: bx, y, w: 40, h: 20 } });
          bx += 46;
        };
        headBtn("ahStart", start, -1);
        headBtn("ahEnd", end, 1);
      });
    }
    if (sel.length) {
      row("Actions", 24, (y) => {
        let bx = x + 64;
        const act = (v: string, glyph: (ix: number, iy: number) => void, w = segW) => {
          p.roundedRect(bx, y, w, 20, 5, hex(t.bgHover));
          glyph(bx + w / 2, y + 10);
          this.propRects.push({ id: "act", value: v, r: { x: bx, y, w, h: 20 } });
          bx += w + 2;
        };
        const dim = hex(t.textDim);
        act("dup", (ix, iy) => {
          p.roundedRect(ix - 5, iy - 3, 9, 8, 2, [0, 0, 0, 0]);
          pt.strokePath([ix - 5, iy - 3, ix - 5, iy - 6, ix + 4, iy - 6, ix + 4, iy + 5, ix - 5, iy + 5, ix - 5, iy - 3], 0.9, dim);
        });
        act("del", (ix, iy) => {
          pt.strokePath([ix - 4, iy - 4, ix + 4, iy + 4], 1.1, hex(t.danger));
          pt.strokePath([ix + 4, iy - 4, ix - 4, iy + 4], 1.1, hex(t.danger));
        });
        act("fwd", (ix, iy) => {
          pt.strokePath([ix - 6, iy + 4, ix + 6, iy + 4], 1.1, dim);
          pt.strokePath([ix - 3, iy, ix + 6, iy], 1.1, dim);
          pt.strokePath([ix + 3, iy - 4, ix + 6, iy, ix + 3, iy + 4], 1, dim);
        });
        act("bwd", (ix, iy) => {
          pt.strokePath([ix - 6, iy + 4, ix + 6, iy + 4], 1.1, dim);
          pt.strokePath([ix - 6, iy, ix + 3, iy], 1.1, dim);
          pt.strokePath([ix - 3, iy - 4, ix - 6, iy, ix - 3, iy + 4], 1, dim);
        });
        act("grp", (ix, iy) => {
          pt.strokePath([ix - 6, iy - 2, ix - 1, iy - 6, ix + 4, iy - 2, ix - 1, iy + 2, ix - 6, iy - 2], 0.9, dim);
        });
      });
    }

    // Draw the panel.
    const pad = 8;
    const totalH = pad * 2 + rows.reduce((a, r) => a + r.h + 2, 0);
    const y = this.rect.y + 58;
    this.panelRect = { x, y, w: W, h: totalH };
    this.propRects = [];
    this.island(x, y, W, totalH, t);
    let ry = y + pad;
    rows.forEach(r => {
      this.pt(x + 10, ry + 6, 10, r.label, hex(t.textFaint), pt);
      r.draw(ry);
      ry += r.h + 2;
    });
  }

  // ── context menu ─────────────────────────────────────────────────────────────

  private drawMenu(pt: WbPainter, t: ReturnType<typeof tokens>): void {
    const p = this.pass;
    const m = this.menu!;
    const W = 190;
    let h = 12;
    m.entries.forEach(e => { h += e === "sep" ? 9 : 24; });
    // Keep the menu inside the canvas.
    const x = Math.min(m.x, this.rect.x + this.rect.w - W - 8);
    const y = Math.min(m.y, this.rect.y + this.rect.h - h - 8);
    this.menuRect = { x, y, w: W, h };
    p.roundedRect(x + 2, y + 4, W, h, 9, [0, 0, 0, 0.45]);
    p.roundedRect(x, y, W, h, 9, hex(t.bgElev));
    const oc = hex(t.line);
    p.rect(x, y, W, 1, oc); p.rect(x, y + h - 1, W, 1, oc);
    p.rect(x, y, 1, h, oc); p.rect(x + W - 1, y, 1, h, oc);
    let ry = y + 6;
    for (let i = 0; i < m.entries.length; i++) {
      const e = m.entries[i]!;
      if (e === "sep") {
        p.rect(x + 8, ry + 4, W - 16, 1, hex(t.lineSoft));
        ry += 9;
        continue;
      }
      if (i === m.hover && e.enabled) p.roundedRect(x + 4, ry, W - 8, 24, 6, hex(t.accentSoft));
      const c = e.enabled ? hex(t.text) : hex(t.textFaint);
      this.pt(x + 12, ry + 6, 12, e.label, c, pt);
      if (e.key) this.pt(x + W - 12 - pt.advance("inter:400:normal", 10, e.key), ry + 8, 10, e.key, hex(t.textFaint), pt);
      ry += 24;
    }
  }

  // ── tool icons ────────────────────────────────────────────────────────────────

  private drawToolIcon(id: string, x: number, y: number, w: number, h: number, c: Rgba,
    pt: WbPainter, t: ReturnType<typeof tokens>): void {
    const p = this.pass;
    const cx = x + w / 2, cy = y + h / 2;
    switch (id) {
      case "lock": {
        p.roundedRect(cx - 5, cy - 1, 10, 8, 2, c);
        p.capsule(cx - 3, cy - 1, cx - 3, cy - 5, 1, c);
        p.capsule(cx - 3, cy - 5, cx - 3, cy - 6, 1, c);
        p.capsule(cx - 3, cy - 6, cx + 3, cy - 6, 1, c);
        p.capsule(cx + 3, cy - 6, cx + 3, cy - 1, 1, c);
        break;
      }
      case "select":
        // Filled pointer cursor (distinct from the arrow tool).
        pt.fillPoly([
          cx - 3.5, cy - 7, cx + 5, cy - 1,
          cx + 0.8, cy - 0.6, cx + 4.2, cy + 4,
          cx + 1.9, cy + 5.4, cx - 0.9, cy + 0.6, cx - 3.5, cy + 2.6,
        ], c);
        break;
      case "hand":
        p.roundedRect(cx - 5, cy - 2, 10, 8, 3, c);
        p.capsule(cx - 3, cy - 2, cx - 3, cy - 7, 1.4, c);
        p.capsule(cx, cy - 2, cx, cy - 8, 1.4, c);
        p.capsule(cx + 3, cy - 2, cx + 3, cy - 7, 1.4, c);
        break;
      case "pen":
        p.capsule(cx - 5, cy + 5, cx + 5, cy - 5, 1.3, c);
        p.capsule(cx + 2, cy + 6, cx + 6, cy + 2, 1.3, c);
        break;
      case "rect":
        p.roundedRect(cx - 6, cy - 5, 12, 10, 1.5, c);
        p.roundedRect(cx - 4.6, cy - 3.6, 9.2, 7.2, 1, hex(t.bgElev));
        break;
      case "diamond":
        pt.strokePath([cx, cy - 6, cx + 6, cy, cx, cy + 6, cx - 6, cy, cx, cy - 6], 1.3, c);
        break;
      case "ellipse":
        p.ellipse(cx - 6, cy - 5, 12, 10, c);
        p.ellipse(cx - 4.6, cy - 3.6, 9.2, 7.2, hex(t.bgElev));
        break;
      case "arrow":
        p.capsule(cx - 6, cy + 5, cx + 5, cy - 5, 1.4, c);
        p.capsule(cx + 5, cy - 5, cx + 0.5, cy - 5.4, 1.2, c);
        p.capsule(cx + 5, cy - 5, cx + 5.6, cy - 0.9, 1.2, c);
        break;
      case "line":
        p.capsule(cx - 6, cy + 6, cx + 6, cy - 6, 1.4, c);
        break;
      case "text":
        pt.text(cx - pt.advance("inter:600:normal", 15, "T") / 2, cy - 8, "inter:600:normal", 15, "T", c);
        break;
      case "sticky":
        p.roundedRect(cx - 6, cy - 5.5, 12, 11, 2, c);
        p.rect(cx - 3.5, cy - 1.5, 7, 1.2, hex(t.bgElev));
        p.rect(cx - 3.5, cy + 1.5, 5, 1.2, hex(t.bgElev));
        break;
      case "eraser":
        p.roundedRect(cx - 6, cy - 4, 12, 8, 2, c);
        p.rect(cx - 6, cy, 12, 1.2, hex(t.bgElev));
        break;
      case "undo":
        pt.strokePath([cx - 5, cy - 2, cx - 5, cy + 3, cx - 1, cy + 6, cx + 4, cy + 6], 1.3, c);
        pt.strokePath([cx - 8, cy - 4, cx - 5, cy - 7, cx - 2, cy - 4], 1.3, c);
        p.capsule(cx - 5, cy - 5, cx - 5, cy - 2, 1.3, c);
        break;
      case "redo":
        pt.strokePath([cx + 5, cy - 2, cx + 5, cy + 3, cx + 1, cy + 6, cx - 4, cy + 6], 1.3, c);
        pt.strokePath([cx + 8, cy - 4, cx + 5, cy - 7, cx + 2, cy - 4], 1.3, c);
        p.capsule(cx + 5, cy - 5, cx + 5, cy - 2, 1.3, c);
        break;
      case "grid":
        [[-4, -4], [2, -4], [-4, 2], [2, 2]].forEach(([dx, dy]) => {
          p.rect(cx + dx!, cy + dy!, 3, 3, c);
        });
        break;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubs.forEach(u => u());
    this.pass.destroy();
  }
}
