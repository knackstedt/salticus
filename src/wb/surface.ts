// ============================================================================
// wb/surface.ts — infinite-canvas whiteboard, custom GPU surface.
//
// Tools: select (click/drag/move items, drag empty = pan), pen (freehand
// capsule strokes), rect, ellipse, line, text, sticky. Wheel pans,
// ctrl+wheel zooms at the cursor. A dot grid anchors space. Persisted per
// page via onChange.
// ============================================================================

import type { ScreenUiCompositor, RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import { GpuTextPass, type Rgba } from "../text/gpu-text";
import { RunCache } from "../text/run-cache";
import { TextAtlas } from "../text/atlas";
import { tokens } from "../app/theme";
import { store } from "../app/store";
import { emptyWhiteboard, newWbItem, type WbContent, type WbItem, type WbItemKind } from "./model";

const TOOLBAR_H = 44;
const TOOLS: { id: Tool; label: string }[] = [
  { id: "select", label: "Select" },
  { id: "pen", label: "Pen" },
  { id: "rect", label: "Rect" },
  { id: "ellipse", label: "Ellipse" },
  { id: "line", label: "Line" },
  { id: "text", label: "Text" },
  { id: "sticky", label: "Sticky" },
];

const WB_COLORS: Rgba[] = [
  [0.91, 0.91, 0.93, 1], // white
  [0.62, 0.55, 0.98, 1], // violet
  [0.40, 0.68, 0.96, 1], // blue
  [0.45, 0.78, 0.50, 1], // green
  [0.95, 0.70, 0.32, 1], // amber
  [0.93, 0.45, 0.48, 1], // red
];
const STICKY_COLORS: Rgba[] = [
  [0.24, 0.22, 0.30, 1],
  [0.30, 0.26, 0.42, 1],
  [0.20, 0.30, 0.40, 1],
  [0.22, 0.34, 0.26, 1],
  [0.40, 0.32, 0.18, 1],
  [0.40, 0.24, 0.24, 1],
];

function hex(s: string): Rgba {
  const h = s.slice(1);
  const n = parseInt(h.slice(0, 6), 16);
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
}

type Tool = "select" | "pen" | "rect" | "ellipse" | "line" | "text" | "sticky";

interface DraftState {
  kind: "pen" | "shape" | "move" | "pan";
  item?: WbItem;
  startX: number; startY: number;   // world coords
  sx0: number; sy0: number;         // pointer screen coords at down
  lastX: number; lastY: number;
  camStart?: { x: number; y: number };
  moveOff?: { x: number; y: number };
  moved: boolean;
}

interface WbEdit {
  itemId: string;
  text: string;
  isNew: boolean;
}

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
  private tool: Tool = "pen";
  private colorIdx = 0;
  private draft: DraftState | null = null;
  private selected: string | null = null;
  private editing: WbEdit | null = null;
  private blinkT = 0;
  private time = 0;
  private toolRects: { id: string; x: number; y: number; w: number; h: number }[] = [];
  private swatchRects: { idx: number; x: number; y: number; w: number; h: number }[] = [];
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
    if (!a) { this.editing = null; this.draft = null; }
  }

  setRect(r: { x: number; y: number; w: number; h: number }): void {
    this.rect = r;
  }

  setContent(c: WbContent | null): void {
    this.wb = c ?? emptyWhiteboard();
    this.editing = null;
    this.draft = null;
    this.selected = null;
  }

  getContent(): WbContent {
    return this.wb;
  }

  private dirty(): void {
    this.onChange?.(this.wb);
  }

  // ----- transforms ---------------------------------------------------------

  private w2sX(wx: number): number {
    return this.rect.x + (wx - this.wb.cam.x) * this.wb.cam.zoom;
  }
  private w2sY(wy: number): number {
    return this.rect.y + TOOLBAR_H + (wy - this.wb.cam.y) * this.wb.cam.zoom;
  }
  private s2wX(sx: number): number {
    return (sx - this.rect.x) / this.wb.cam.zoom + this.wb.cam.x;
  }
  private s2wY(sy: number): number {
    return (sy - this.rect.y - TOOLBAR_H) / this.wb.cam.zoom + this.wb.cam.y;
  }

  // ----- input --------------------------------------------------------------

  private installInput(): void {
    const bus = this.ctx.getInputBus();
    const inCanvas = (x: number, y: number) =>
      this.active && x >= this.rect.x && y >= this.rect.y + TOOLBAR_H &&
      x <= this.rect.x + this.rect.w && y <= this.rect.y + this.rect.h;
    const inToolbar = (x: number, y: number) =>
      this.active && x >= this.rect.x && y >= this.rect.y &&
      x <= this.rect.x + this.rect.w && y <= this.rect.y + TOOLBAR_H;

    this.unsubs.push(bus.onPointerDown((e, ctrl) => {
      if (inToolbar(e.clientX, e.clientY)) {
        for (const t of this.toolRects) {
          if (e.clientX >= t.x && e.clientX <= t.x + t.w && e.clientY >= t.y && e.clientY <= t.y + t.h) {
            this.tool = t.id as Tool;
            ctrl.stopPropagation();
            return;
          }
        }
        for (const s of this.swatchRects) {
          if (e.clientX >= s.x && e.clientX <= s.x + s.w && e.clientY >= s.y && e.clientY <= s.y + s.h) {
            this.colorIdx = s.idx;
            ctrl.stopPropagation();
            return;
          }
        }
        ctrl.stopPropagation();
        return;
      }
      if (!inCanvas(e.clientX, e.clientY)) return;
      ctrl.stopPropagation();
      if (this.editing) this.commitEdit();

      const wx = this.s2wX(e.clientX);
      const wy = this.s2wY(e.clientY);
      const z = this.wb.cam.zoom;

      switch (this.tool) {
        case "pen": {
          const item = newWbItem("stroke", wx, wy, this.colorIdx, 2.5);
          item.points = [wx, wy];
          this.draft = { kind: "pen", item, startX: wx, startY: wy, sx0: e.clientX, sy0: e.clientY, lastX: wx, lastY: wy, moved: false };
          break;
        }
        case "rect":
        case "ellipse":
        case "line": {
          const item = newWbItem(this.tool, wx, wy, this.colorIdx, 2);
          this.draft = { kind: "shape", item, startX: wx, startY: wy, sx0: e.clientX, sy0: e.clientY, lastX: wx, lastY: wy, moved: false };
          break;
        }
        case "text": {
          const item = newWbItem("text", wx, wy, this.colorIdx, 18);
          item.text = "";
          this.wb.items.push(item);
          this.editing = { itemId: item.id, text: "", isNew: true };
          this.dirty();
          break;
        }
        case "sticky": {
          const item = newWbItem("sticky", wx - 95, wy - 95, this.colorIdx, 13);
          item.w = 190; item.h = 190; item.text = "";
          this.wb.items.push(item);
          this.editing = { itemId: item.id, text: "", isNew: true };
          this.dirty();
          break;
        }
        case "select":
        default: {
          const hit = this.hitAt(wx, wy);
          if (hit) {
            this.selected = hit.id;
            this.draft = {
              kind: "move", item: hit, startX: wx, startY: wy, sx0: e.clientX, sy0: e.clientY,
              lastX: wx, lastY: wy,
              moveOff: { x: hit.x - wx, y: hit.y - wy }, moved: false,
            };
          } else {
            this.selected = null;
            this.draft = {
              kind: "pan", startX: wx, startY: wy, sx0: e.clientX, sy0: e.clientY,
              lastX: wx, lastY: wy,
              camStart: { x: this.wb.cam.x, y: this.wb.cam.y }, moved: false,
            };
          }
          break;
        }
      }
    }, 55));

    this.unsubs.push(bus.onPointerMove((e) => {
      if (!this.active || !this.draft) return;
      const d = this.draft;
      const wx = this.s2wX(e.clientX);
      const wy = this.s2wY(e.clientY);
      d.moved = true;
      if (d.kind === "pen" && d.item?.points) {
        const pts = d.item.points;
        const lx = pts[pts.length - 2]!, ly = pts[pts.length - 1]!;
        if (Math.hypot(wx - lx, wy - ly) > 1.5 / this.wb.cam.zoom) {
          pts.push(wx, wy);
        }
      } else if (d.kind === "shape" && d.item) {
        let w = wx - d.startX, h = wy - d.startY;
        if (e.shiftKey && d.item.kind !== "line") {
          const m = Math.max(Math.abs(w), Math.abs(h));
          w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m;
        }
        d.item.w = w; d.item.h = h;
      } else if (d.kind === "move" && d.item) {
        d.item.x = wx + d.moveOff!.x;
        d.item.y = wy + d.moveOff!.y;
      } else if (d.kind === "pan" && d.camStart) {
        const z = this.wb.cam.zoom;
        this.wb.cam.x = d.camStart.x - (e.clientX - d.sx0) / z;
        this.wb.cam.y = d.camStart.y - (e.clientY - d.sy0) / z;
      }
      d.lastX = wx; d.lastY = wy;
    }));

    this.unsubs.push(bus.onPointerUp(() => {
      if (!this.draft) return;
      const d = this.draft;
      this.draft = null;
      if (d.kind === "pen" && d.item?.points && d.item.points.length >= 2) {
        this.wb.items.push(d.item);
        this.dirty();
      } else if (d.kind === "shape" && d.item) {
        // Normalize negative extents.
        if (d.item.w < 0) { d.item.x += d.item.w; d.item.w = -d.item.w; }
        if (d.item.h < 0) { d.item.y += d.item.h; d.item.h = -d.item.h; }
        if (d.item.w > 2 || d.item.h > 2 || d.item.kind === "line") {
          this.wb.items.push(d.item);
          this.dirty();
        }
      } else if (d.kind === "move" && d.moved) {
        this.dirty();
      } else if (d.kind === "pan" && d.moved) {
        this.dirty();
      }
    }));

    this.unsubs.push(bus.onWheel((e, ctrl) => {
      if (!inCanvas(e.clientX, e.clientY)) return;
      ctrl.stopPropagation();
      const z = this.wb.cam.zoom;
      if (e.ctrlKey || e.metaKey) {
        // Zoom at cursor: keep the world point under the pointer fixed.
        const wx = this.s2wX(e.clientX), wy = this.s2wY(e.clientY);
        const nz = Math.max(0.2, Math.min(4, z * Math.exp(-e.deltaY * 0.0015)));
        this.wb.cam.x = wx - (e.clientX - this.rect.x) / nz;
        this.wb.cam.y = wy - (e.clientY - this.rect.y - TOOLBAR_H) / nz;
        this.wb.cam.zoom = nz;
      } else {
        this.wb.cam.x += e.deltaX / z;
        this.wb.cam.y += e.deltaY / z;
      }
      this.dirty();
    }, 55));

    this.unsubs.push(bus.onKeyDown((e, ctrl) => {
      if (!this.active) return;
      if (this.editing) {
        const key = e.key;
        if (key === "Enter" && !e.shiftKey) { this.commitEdit(); ctrl.stopPropagation(); return; }
        if (key === "Escape") { this.cancelEdit(); ctrl.stopPropagation(); return; }
        if (key === "Backspace") {
          this.editing.text = this.editing.text.slice(0, -1);
          ctrl.stopPropagation();
          return;
        }
        if (key === "Enter" && e.shiftKey) {
          this.editing.text += "\n";
          ctrl.stopPropagation();
          return;
        }
        if (key.length === 1 && !e.ctrlKey && !e.metaKey) {
          this.editing.text += key;
          ctrl.stopPropagation();
        }
        return;
      }
      if (this.selected && (e.key === "Delete" || e.key === "Backspace")) {
        this.wb.items = this.wb.items.filter(i => i.id !== this.selected);
        this.selected = null;
        this.dirty();
        ctrl.stopPropagation();
      }
      // Tool shortcuts: v p r o l t s
      const toolKeys: Record<string, Tool> = { v: "select", p: "pen", r: "rect", o: "ellipse", l: "line", t: "text", s: "sticky" };
      const tk = toolKeys[e.key.toLowerCase()];
      if (tk) { this.tool = tk; ctrl.stopPropagation(); }
    }, 60));

    const onText = (ev: Event) => {
      if (!this.active || !this.editing) return;
      const s = (ev as { data?: string }).data;
      if (s) this.editing.text += s;
    };
    window.addEventListener("textinput", onText);
    this.unsubs.push(() => window.removeEventListener("textinput", onText));
  }

  private hitAt(wx: number, wy: number): WbItem | null {
    for (let i = this.wb.items.length - 1; i >= 0; i--) {
      const it = this.wb.items[i]!;
      switch (it.kind) {
        case "rect":
        case "ellipse":
        case "sticky":
          if (wx >= it.x - 4 && wx <= it.x + it.w + 4 && wy >= it.y - 4 && wy <= it.y + it.h + 4) return it;
          break;
        case "line":
          if (distToSeg(wx, wy, it.x, it.y, it.x + it.w, it.y + it.h) < 8) return it;
          break;
        case "stroke": {
          const p = it.points ?? [];
          for (let j = 0; j + 3 < p.length; j += 2) {
            if (distToSeg(wx, wy, p[j]!, p[j + 1]!, p[j + 2]!, p[j + 3]!) < it.size + 4) return it;
          }
          break;
        }
        case "text": {
          const w = this.measure("inter:400:normal", it.size, it.text ?? "");
          if (wx >= it.x && wx <= it.x + w && wy >= it.y - it.size && wy <= it.y + 4) return it;
          break;
        }
      }
    }
    return null;
  }

  private commitEdit(): void {
    const e = this.editing;
    if (!e) return;
    this.editing = null;
    const item = this.wb.items.find(i => i.id === e.itemId);
    if (!item) return;
    if (!e.text.trim() && e.isNew) {
      this.wb.items = this.wb.items.filter(i => i.id !== e.itemId);
    } else {
      item.text = e.text;
    }
    this.dirty();
  }

  private cancelEdit(): void {
    const e = this.editing;
    this.editing = null;
    if (e?.isNew) {
      this.wb.items = this.wb.items.filter(i => i.id !== e.itemId);
      this.dirty();
    }
  }

  // ----- render -------------------------------------------------------------

  private t(): ReturnType<typeof tokens> {
    return tokens(store.getState().theme);
  }

  private text(x: number, y: number, face: string, size: number, str: string, color: Rgba): void {
    const chunk = this.cache.getChunk(face, size, str);
    if (!chunk || !chunk.region) return;
    this.pass.text(Math.round(x + chunk.inkX), Math.round(y), chunk.w, chunk.h,
      { region: chunk.region, atlasSize: this.atlas.size }, color);
  }

  private measure(face: string, size: number, str: string): number {
    return this.cache.getRun(face, size, str)?.advance ?? str.length * size * 0.55;
  }

  update(dt: number): void {
    this.time += dt;
    this.blinkT += dt;
  }

  hasContent(): boolean {
    return this.active && this.cache.ready && !this.disposed;
  }

  render(pass: GPURenderPassEncoder, surfaceW: number, surfaceH: number): void {
    if (this.rect.w <= 0) return;
    const p = this.pass;
    const t = this.t();
    const z = this.wb.cam.zoom;
    p.begin();

    // Canvas region (below toolbar) is scissor-clipped; toolbar + overlays not.
    const canvasScissor: [number, number, number, number] =
      [this.rect.x, this.rect.y + TOOLBAR_H, this.rect.w, this.rect.h - TOOLBAR_H];
    const ranges: { start: number; end: number; scissor?: [number, number, number, number] }[] =
      [{ start: 0, end: -1, scissor: canvasScissor }];

    p.rect(this.rect.x, this.rect.y, this.rect.w, this.rect.h, hex(t.bg));

    // Dot grid.
    const spacing = 44 * z;
    if (spacing > 10) {
      const dot = hex(t.lineSoft);
      const gx0 = this.rect.x - ((this.wb.cam.x * z) % spacing);
      const gy0 = this.rect.y + TOOLBAR_H - ((this.wb.cam.y * z) % spacing);
      for (let gy = gy0; gy < this.rect.y + this.rect.h; gy += spacing) {
        for (let gx = gx0; gx < this.rect.x + this.rect.w; gx += spacing) {
          p.roundedRect(gx - 0.75, gy - 0.75, 1.5, 1.5, 0.75, dot);
        }
      }
    }

    // Items.
    for (const it of this.wb.items) {
      this.drawItem(it, false);
    }
    // In-progress pen/shape draft.
    if (this.draft?.item) this.drawItem(this.draft.item, true);

    // Selection outline.
    if (this.selected) {
      const it = this.wb.items.find(i => i.id === this.selected);
      if (it) {
        const [bx, by, bw, bh] = this.itemBounds(it);
        const pad = 6;
        p.roundedRect(bx - pad, by - pad, bw + pad * 2, bh + pad * 2, 6, [0, 0, 0, 0]);
        // outline via 4 thin rects
        const c = hex(t.accent);
        p.rect(bx - pad, by - pad, bw + pad * 2, 1.5, c);
        p.rect(bx - pad, by + bh + pad, bw + pad * 2, 1.5, c);
        p.rect(bx - pad, by - pad, 1.5, bh + pad * 2, c);
        p.rect(bx + bw + pad, by - pad, 1.5, bh + pad * 2, c);
      }
    }
    ranges[0]!.end = p.quadCount;

    // Toolbar (unclipped).
    ranges.push({ start: p.quadCount, end: -1 });
    this.drawToolbar(t);
    ranges[ranges.length - 1]!.end = p.quadCount;

    for (const r of ranges) if (r.end < 0) r.end = p.quadCount;
    p.renderRanges(pass, surfaceW, surfaceH, this.atlas, this.time, ranges);
  }

  private itemBounds(it: WbItem): [number, number, number, number] {
    const sx = this.w2sX(it.x), sy = this.w2sY(it.y);
    const z = this.wb.cam.zoom;
    switch (it.kind) {
      case "stroke": {
        const p = it.points ?? [];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i + 1 < p.length; i += 2) {
          minX = Math.min(minX, p[i]!); maxX = Math.max(maxX, p[i]!);
          minY = Math.min(minY, p[i + 1]!); maxY = Math.max(maxY, p[i + 1]!);
        }
        if (!isFinite(minX)) return [sx, sy, 0, 0];
        return [this.w2sX(minX), this.w2sY(minY), (maxX - minX) * z, (maxY - minY) * z];
      }
      case "text": {
        const w = this.measure("inter:400:normal", it.size * z, it.text ?? "");
        const lines = (it.text ?? "").split("\n").length;
        return [sx, sy - it.size * z, Math.max(w, 20), (lines * it.size * 1.35) * z];
      }
      default:
        return [sx, sy, Math.abs(it.w) * z, Math.abs(it.h) * z];
    }
  }

  private drawItem(it: WbItem, isDraft: boolean): void {
    const p = this.pass;
    const z = this.wb.cam.zoom;
    const color = WB_COLORS[it.color % WB_COLORS.length]!;
    const sx = this.w2sX(it.x), sy = this.w2sY(it.y);
    const editingThis = this.editing?.itemId === it.id;

    switch (it.kind) {
      case "stroke": {
        const pts = it.points ?? [];
        const sp: number[] = [];
        for (let i = 0; i < pts.length; i += 2) {
          sp.push(this.w2sX(pts[i]!), this.w2sY(pts[i + 1]!));
        }
        p.stroke(sp, Math.max(1, it.size * z), color);
        break;
      }
      case "rect": {
        const w = it.w * z, h = it.h * z;
        const x = Math.min(sx, sx + w), y = Math.min(sy, sy + h);
        const aw = Math.abs(w), ah = Math.abs(h);
        const lw = Math.max(1, it.size * z);
        // Outline via 4 rects? Rounded rect stroke not supported — draw thin outline as 4 rects.
        p.rect(x, y, aw, lw, color);
        p.rect(x, y + ah - lw, aw, lw, color);
        p.rect(x, y, lw, ah, color);
        p.rect(x + aw - lw, y, lw, ah, color);
        break;
      }
      case "ellipse": {
        const x = Math.min(sx, sx + it.w * z), y = Math.min(sy, sy + it.h * z);
        const aw = Math.abs(it.w * z), ah = Math.abs(it.h * z);
        const lw = Math.max(1, it.size * z);
        p.ellipse(x, y, aw, ah, color);
        p.ellipse(x + lw, y + lw, Math.max(0.1, aw - lw * 2), Math.max(0.1, ah - lw * 2), hex(this.t().bg));
        break;
      }
      case "line": {
        p.capsule(sx, sy, sx + it.w * z, sy + it.h * z, Math.max(1, it.size * z), color);
        break;
      }
      case "text": {
        const str = editingThis ? this.editing!.text : (it.text ?? "");
        const sizePx = Math.max(6, it.size * z);
        const lines = str.split("\n");
        let ly = sy - it.size * z;
        for (const line of lines) {
          this.text(sx, ly + (sizePx * 1.35 - sizePx) * 0.2, "inter:400:normal", sizePx, line || " ", color);
          ly += sizePx * 1.35;
        }
        if (editingThis && this.blinkT % 1 < 0.53) {
          const last = lines[lines.length - 1] ?? "";
          const tw = this.measure("inter:400:normal", sizePx, last);
          p.rect(sx + tw + 2, ly - sizePx * 1.35, 1.5, sizePx, hex(this.t().accent));
        }
        break;
      }
      case "sticky": {
        const w = it.w * z, h = it.h * z;
        const bg = STICKY_COLORS[it.color % STICKY_COLORS.length]!;
        p.roundedRect(sx + 3, sy + 4, w, h, 6, [0, 0, 0, 0.3]);
        p.roundedRect(sx, sy, w, h, 6, bg);
        p.roundedRect(sx, sy, w, Math.min(h, 26 * z), 6, [1, 1, 1, 0.06]);
        const str = editingThis ? this.editing!.text : (it.text ?? "");
        const sizePx = Math.max(6, it.size * z);
        const lines = str.split("\n");
        let ly = sy + 32 * z;
        for (const line of lines) {
          this.text(sx + 10 * z, ly, "inter:400:normal", sizePx, line || " ", [0.92, 0.92, 0.94, 0.95]);
          ly += sizePx * 1.35;
        }
        if (editingThis && this.blinkT % 1 < 0.53) {
          const last = lines[lines.length - 1] ?? "";
          const tw = this.measure("inter:400:normal", sizePx, last);
          p.rect(sx + 10 * z + tw + 2, ly - sizePx * 1.35, 1.5, sizePx, hex(this.t().accent));
        }
        break;
      }
    }
  }

  private drawToolbar(t: ReturnType<typeof tokens>): void {
    const p = this.pass;
    const ty = this.rect.y;
    const tx = this.rect.x;
    this.toolRects = [];
    this.swatchRects = [];

    p.roundedRect(tx + 10, ty + 6, Math.min(this.rect.w - 20, 402), 32, 8, hex(t.bgElev));
    let x = tx + 16;
    for (const tl of TOOLS) {
      const active = this.tool === tl.id;
      const w = 34;
      if (active) p.roundedRect(x, ty + 10, w, 24, 6, hex(t.accentSoft));
      this.drawToolIcon(tl.id, x, ty + 10, w, 24, hex(active ? t.accentText : t.textDim));
      this.toolRects.push({ id: tl.id, x, y: ty + 10, w, h: 24 });
      x += w + 2;
    }
    // Divider.
    p.rect(x + 4, ty + 12, 1, 20, hex(t.line));
    x += 12;
    // Color swatches.
    for (let i = 0; i < WB_COLORS.length; i++) {
      const sel = this.colorIdx === i;
      p.roundedRect(x, ty + 15, 14, 14, 7, WB_COLORS[i]!);
      if (sel) {
        p.roundedRect(x - 2, ty + 13, 18, 18, 9, [1, 1, 1, 0.12]);
      }
      this.swatchRects.push({ idx: i, x: x - 2, y: ty + 11, w: 18, h: 18 });
      x += 22;
    }
    // Zoom readout.
    const pct = `${Math.round(this.wb.cam.zoom * 100)}%`;
    p.rect(this.rect.x + this.rect.w - 60, ty + 12, 48, 20, hex(t.bgElev));
    this.text(this.rect.x + this.rect.w - 60 + (48 - this.measure("inter:400:normal", 11, pct)) / 2,
      ty + 16, "inter:400:normal", 11, pct, hex(t.textDim));

    const hint = "V select · P pen · R rect · O ellipse · L line · T text · S sticky · drag empty space pans · ctrl+wheel zooms";
    this.text(tx + 16, ty + TOOLBAR_H - 2, "inter:400:normal", 10, hint, hex(t.textFaint));
  }

  /** Mini tool glyphs drawn with pass primitives (Inter lacks icon glyphs). */
  private drawToolIcon(id: Tool, x: number, y: number, w: number, h: number, c: Rgba): void {
    const p = this.pass;
    const cx = x + w / 2, cy = y + h / 2;
    switch (id) {
      case "select": // ↗ arrow cursor-ish
        p.capsule(cx - 5, cy + 6, cx + 6, cy - 7, 1.2, c);
        p.capsule(cx + 6, cy - 7, cx + 1, cy - 7, 1.2, c);
        p.capsule(cx + 6, cy - 7, cx + 6, cy - 2, 1.2, c);
        break;
      case "pen": // diagonal nib stroke
        p.capsule(cx - 5, cy + 5, cx + 5, cy - 5, 1.2, c);
        p.capsule(cx + 2, cy + 6, cx + 6, cy + 2, 1.2, c);
        break;
      case "rect":
        p.roundedRect(cx - 6, cy - 5, 12, 10, 1.5, c);
        p.roundedRect(cx - 4.8, cy - 3.8, 9.6, 7.6, 1, hex(this.t().bgElev));
        break;
      case "ellipse":
        p.ellipse(cx - 6, cy - 5, 12, 10, c);
        p.ellipse(cx - 4.8, cy - 3.8, 9.6, 7.6, hex(this.t().bgElev));
        break;
      case "line":
        p.capsule(cx - 6, cy + 6, cx + 6, cy - 6, 1.4, c);
        break;
      case "text":
        this.text(cx - this.measure("inter:600:normal", 15, "T") / 2, cy - 8,
          "inter:600:normal", 15, "T", c);
        break;
      case "sticky":
        p.roundedRect(cx - 6, cy - 5.5, 12, 11, 2, c);
        p.rect(cx - 3.5, cy - 1.5, 7, 1.2, hex(this.t().bgElev));
        p.rect(cx - 3.5, cy + 1.5, 5, 1.2, hex(this.t().bgElev));
        break;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.pass.destroy();
  }
}

function distToSeg(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
  return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
}
