// ============================================================================
// board/surface.ts — custom GPU kanban view.
//
// A ScreenUiCompositor sharing the editor's glyph pipeline: columns render as
// rounded panels, cards as raised rounded rects with shaped text. Cards drag
// freely between columns with a live drop indicator; each column scrolls
// independently (quad ranges are scissor-clipped per column).
// ============================================================================

import type { ScreenUiCompositor, RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import { GpuTextPass, type Rgba } from "../text/gpu-text";
import { RunCache } from "../text/run-cache";
import { TextAtlas } from "../text/atlas";
import { tokens } from "../app/theme";
import { store } from "../app/store";
import { newCard, newColumn, type BoardContent, type BoardCard, type BoardColumn } from "./model";

const COL_W = 272;
const COL_GAP = 14;
const COL_X = 28;
const COL_TOP = 44;
const HEADER_H = 34;
const CARD_PAD = 10;
const CARD_GAP = 8;
const ADD_H = 30;

const COL_DOT: Rgba[] = [
  [0.62, 0.58, 0.98, 1], // violet
  [0.35, 0.68, 0.95, 1], // blue
  [0.95, 0.70, 0.30, 1], // amber
  [0.45, 0.78, 0.48, 1], // green
  [0.93, 0.45, 0.48, 1], // red
  [0.55, 0.72, 0.82, 1], // slate
];
const TAG_COLORS: Rgba[] = [
  [0.32, 0.29, 0.52, 1], [0.20, 0.36, 0.52, 1], [0.46, 0.32, 0.18, 1],
  [0.22, 0.40, 0.26, 1], [0.45, 0.24, 0.26, 1],
];

function hex(s: string): Rgba {
  const h = s.slice(1);
  const n = parseInt(h.slice(0, 6), 16);
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
}

interface DragState {
  card: BoardCard;
  fromCol: string;
  x: number; y: number;          // pointer pos
  grabX: number; grabY: number;  // pointer offset inside card
  w: number; h: number;          // card dims
  started: boolean;
  targetCol: string | null;
  targetIdx: number;
}

interface EditState {
  colId: string;
  cardId: string | null; // null → editing the column title
  text: string;
  isNew: boolean;
}

interface CardGeom { card: BoardCard; x: number; y: number; w: number; h: number }

export class KanbanSurface implements ScreenUiCompositor {
  order = -10;
  private pass: GpuTextPass;
  private cache: RunCache;
  private atlas: TextAtlas;
  private rect = { x: 0, y: 0, w: 0, h: 0 };
  private board: BoardContent = { columns: [] };
  private unsubs: (() => void)[] = [];
  private disposed = false;
  private active = false;
  private scroll = new Map<string, number>();
  private offsetX = 0;
  private drag: DragState | null = null;
  private editing: EditState | null = null;
  private blinkT = 0;
  private time = 0;
  private lastTickMs = 0;
  private hoverCard: string | null = null;
  onChange: ((b: BoardContent) => void) | null = null;

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
    if (!a) { this.editing = null; this.drag = null; }
  }

  setRect(r: { x: number; y: number; w: number; h: number }): void {
    this.rect = r;
  }

  setBoard(b: BoardContent | null): void {
    this.board = b ?? { columns: [newColumn("To Do", 0), newColumn("In Progress", 1), newColumn("Done", 3)] };
    this.editing = null;
    this.drag = null;
  }

  getBoard(): BoardContent {
    return this.board;
  }

  private dirty(): void {
    this.onChange?.(this.board);
  }

  // ----- geometry -----------------------------------------------------------

  private colX(i: number): number {
    return this.rect.x + COL_X + i * (COL_W + COL_GAP) - this.offsetX;
  }

  private cardH(c: BoardCard): number {
    let h = CARD_PAD * 2 + 20; // title line
    if (c.desc) h += this.descLines(c).length * 16 + 4;
    if (c.tags.length > 0) h += 22;
    return h;
  }

  private descLines(c: BoardCard): string[] {
    const maxW = COL_W - CARD_PAD * 2;
    const lines: string[] = [];
    for (const para of c.desc.split("\n")) {
      let cur = "";
      for (const word of para.split(" ")) {
        const cand = cur ? cur + " " + word : word;
        const w = this.cache.getRun("inter:400:normal", 12, cand)?.advance ?? cand.length * 6;
        if (w > maxW && cur) { lines.push(cur); cur = word; } else cur = cand;
      }
      lines.push(cur);
    }
    return lines;
  }

  private colScroll(colId: string): number {
    return this.scroll.get(colId) ?? 0;
  }

  private colCardsTop(col: BoardColumn): number {
    return this.rect.y + COL_TOP + HEADER_H - this.colScroll(col.id);
  }

  private colH(col: BoardColumn): number {
    let h = HEADER_H + ADD_H + 8;
    for (const c of col.cards) h += this.cardH(c) + CARD_GAP;
    return Math.min(h, this.rect.h - COL_TOP - 16);
  }

  private cardGeoms(colIdx: number): CardGeom[] {
    const col = this.board.columns[colIdx]!;
    const x = this.colX(colIdx) + 8;
    let y = this.colCardsTop(col) + 4;
    const out: CardGeom[] = [];
    for (const c of col.cards) {
      const h = this.cardH(c);
      out.push({ card: c, x, y, w: COL_W - 16, h });
      y += h + CARD_GAP;
    }
    return out;
  }

  private hitColumn(x: number): number {
    for (let i = 0; i < this.board.columns.length; i++) {
      const cx = this.colX(i);
      if (x >= cx && x <= cx + COL_W) return i;
    }
    return -1;
  }

  private hitCard(x: number, y: number): { col: number; geom: CardGeom } | null {
    const ci = this.hitColumn(x);
    if (ci < 0) return null;
    for (const g of this.cardGeoms(ci)) {
      if (x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h) {
        return { col: ci, geom: g };
      }
    }
    return null;
  }

  private hitHeader(x: number, y: number): number {
    if (y < this.rect.y + COL_TOP || y > this.rect.y + COL_TOP + HEADER_H) return -1;
    return this.hitColumn(x);
  }

  private hitAddCard(x: number, y: number): number {
    const ci = this.hitColumn(x);
    if (ci < 0) return -1;
    const col = this.board.columns[ci]!;
    const addY = this.rect.y + COL_TOP + this.colH(col) - ADD_H;
    return y >= addY && y <= addY + ADD_H ? ci : -1;
  }

  private hitAddList(x: number, y: number): boolean {
    const ax = this.colX(this.board.columns.length);
    return x >= ax && x <= ax + COL_W &&
      y >= this.rect.y + COL_TOP && y <= this.rect.y + COL_TOP + 40;
  }

  // ----- input --------------------------------------------------------------

  private installInput(): void {
    const bus = this.ctx.getInputBus();
    const inRect = (x: number, y: number) =>
      this.active && x >= this.rect.x && y >= this.rect.y &&
      x <= this.rect.x + this.rect.w && y <= this.rect.y + this.rect.h;

    this.unsubs.push(bus.onPointerDown((e, ctrl) => {
      if (!inRect(e.clientX, e.clientY)) return;
      ctrl.stopPropagation();
      const x = e.clientX, y = e.clientY;
      if (this.editing && !this.hitEditingCard(x, y)) this.commitEdit();

      const hc = this.hitCard(x, y);
      if (hc && e.button === 2) {
        this.board.columns[hc.col]!.cards = this.board.columns[hc.col]!.cards.filter(c => c.id !== hc.geom.card.id);
        this.dirty();
        return;
      }
      if (hc) {
        this.drag = {
          card: hc.geom.card, fromCol: this.board.columns[hc.col]!.id,
          x, y, grabX: x - hc.geom.x, grabY: y - hc.geom.y,
          w: hc.geom.w, h: hc.geom.h,
          started: false, targetCol: null, targetIdx: -1,
        };
        return;
      }
      const hi = this.hitHeader(x, y);
      if (hi >= 0) {
        const col = this.board.columns[hi]!;
        // "+" zone on the right of the header adds a card.
        if (x > this.colX(hi) + COL_W - 30) {
          const card = newCard("");
          col.cards.push(card);
          this.editing = { colId: col.id, cardId: card.id, text: "", isNew: true };
          this.dirty();
        } else {
          this.editing = { colId: col.id, cardId: null, text: col.title, isNew: false };
        }
        return;
      }
      const ai = this.hitAddCard(x, y);
      if (ai >= 0) {
        const col = this.board.columns[ai]!;
        const card = newCard("");
        col.cards.push(card);
        this.editing = { colId: col.id, cardId: card.id, text: "", isNew: true };
        this.dirty();
        return;
      }
      if (this.hitAddList(x, y)) {
        const col = newColumn("New list", this.board.columns.length % COL_DOT.length);
        this.board.columns.push(col);
        this.editing = { colId: col.id, cardId: null, text: "New list", isNew: false };
        this.dirty();
      }
    }, 55));

    this.unsubs.push(bus.onPointerMove((e) => {
      if (!this.active) return;
      if (this.drag) {
        const d = this.drag;
        d.x = e.clientX; d.y = e.clientY;
        if (!d.started && Math.hypot(d.x - (d.x), 0) === 0) { /* noop */ }
        if (!d.started) d.started = true;
        if (d.started) {
          const ci = this.hitColumn(d.x);
          if (ci >= 0) {
            const col = this.board.columns[ci]!;
            d.targetCol = col.id;
            // Insertion index by card midpoints.
            const geoms = this.cardGeoms(ci).filter(g => g.card.id !== d.card.id);
            d.targetIdx = geoms.length;
            for (let i = 0; i < geoms.length; i++) {
              if (d.y < geoms[i]!.y + geoms[i]!.h / 2) { d.targetIdx = i; break; }
            }
          } else {
            d.targetCol = null;
          }
        }
        return;
      }
      const hc = this.hitCard(e.clientX, e.clientY);
      this.hoverCard = hc?.geom.card.id ?? null;
    }));

    this.unsubs.push(bus.onPointerUp(() => {
      if (!this.drag) return;
      const d = this.drag;
      this.drag = null;
      if (!d.started) {
        // Plain click → edit card title.
        this.editing = { colId: d.fromCol, cardId: d.card.id, text: d.card.title, isNew: false };
        return;
      }
      if (d.targetCol !== null && d.targetIdx >= 0) {
        const src = this.board.columns.find(c => c.id === d.fromCol)!;
        src.cards = src.cards.filter(c => c.id !== d.card.id);
        const dst = this.board.columns.find(c => c.id === d.targetCol)!;
        dst.cards.splice(Math.min(d.targetIdx, dst.cards.length), 0, d.card);
        this.dirty();
      }
    }));

    this.unsubs.push(bus.onWheel((e, ctrl) => {
      if (!inRect(e.clientX, e.clientY)) return;
      ctrl.stopPropagation();
      const ci = this.hitColumn(e.clientX);
      const col = ci >= 0 ? this.board.columns[ci]! : null;
      const vMax = col ? Math.max(0, this.colContentH(col) - (this.colH(col) - HEADER_H - ADD_H)) : 0;
      if (col && vMax > 0) {
        const cur = this.colScroll(col.id);
        this.scroll.set(col.id, Math.max(0, Math.min(vMax, cur + e.deltaY)));
      } else {
        const total = this.board.columns.length * (COL_W + COL_GAP);
        this.offsetX = Math.max(0, Math.min(Math.max(0, total - this.rect.w + 60), this.offsetX + e.deltaY));
      }
    }, 55));

    this.unsubs.push(bus.onKeyDown((e, ctrl) => {
      if (!this.active || !this.editing) return;
      const key = e.key;
      if (key === "Enter") { this.commitEdit(); ctrl.stopPropagation(); return; }
      if (key === "Escape") { this.cancelEdit(); ctrl.stopPropagation(); return; }
      if (key === "Backspace") {
        this.editing.text = this.editing.text.slice(0, -1);
        ctrl.stopPropagation();
        return;
      }
      if (key.length === 1 && !e.ctrlKey && !e.metaKey) {
        this.editing.text += key;
        ctrl.stopPropagation();
      }
    }, 60));

    // Native textinput for IME/typing fidelity.
    const onText = (ev: Event) => {
      if (!this.active || !this.editing) return;
      const s = (ev as { data?: string }).data;
      if (s) this.editing.text += s;
    };
    window.addEventListener("textinput", onText);
    this.unsubs.push(() => window.removeEventListener("textinput", onText));
  }

  private hitEditingCard(x: number, y: number): boolean {
    if (!this.editing?.cardId) return false;
    const ci = this.board.columns.findIndex(c => c.id === this.editing!.colId);
    if (ci < 0) return false;
    const g = this.cardGeoms(ci).find(g => g.card.id === this.editing!.cardId);
    return !!g && x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h;
  }

  private colContentH(col: BoardColumn): number {
    let h = 8;
    for (const c of col.cards) h += this.cardH(c) + CARD_GAP;
    return h;
  }

  private commitEdit(): void {
    const e = this.editing;
    if (!e) return;
    this.editing = null;
    const col = this.board.columns.find(c => c.id === e.colId);
    if (!col) return;
    const text = e.text.trim();
    if (e.cardId === null) {
      if (text) col.title = text;
    } else {
      const card = col.cards.find(c => c.id === e.cardId);
      if (!text && e.isNew) {
        col.cards = col.cards.filter(c => c.id !== e.cardId);
      } else if (card) {
        if (!text) col.cards = col.cards.filter(c => c.id !== e.cardId);
        else card.title = text;
      }
    }
    this.dirty();
  }

  private cancelEdit(): void {
    const e = this.editing;
    this.editing = null;
    if (e?.isNew && e.cardId) {
      const col = this.board.columns.find(c => c.id === e.colId);
      if (col) {
        col.cards = col.cards.filter(c => c.id !== e.cardId);
        this.dirty();
      }
    }
  }

  // ----- render -------------------------------------------------------------

  private t(): ReturnType<typeof tokens> {
    return tokens(store.getState().theme);
  }

  /** Draw `str` with its baseline `ascent` px below `y` — anchored to font
   *  metrics, not ink height (so descenders don't shift alignment), and
   *  pixel-snapped for crispness. */
  private text(x: number, y: number, face: string, size: number, str: string, color: Rgba): void {
    const chunk = this.cache.getChunk(face, size, str);
    if (!chunk || !chunk.region) return;
    const run = this.cache.getRun(face, size, str);
    const baseline = y + (run?.ascent ?? size * 0.8);
    this.pass.text(Math.round(x + chunk.inkX), Math.round(baseline - chunk.baselineInBitmap),
      chunk.w, chunk.h, { region: chunk.region, atlasSize: this.atlas.size }, color);
  }

  private measure(face: string, size: number, str: string): number {
    return this.cache.getRun(face, size, str)?.advance ?? str.length * size * 0.55;
  }

  update(dt: number): void {
    // Wall-clock delta — see EditorSurface.tick (sparse renderOnce service).
    const nowMs = performance.now();
    const rdt = this.lastTickMs > 0 ? Math.min(0.5, (nowMs - this.lastTickMs) / 1000) : dt;
    this.lastTickMs = nowMs;
    this.time += rdt;
    this.blinkT += rdt;
  }

  hasContent(): boolean {
    return this.active && this.cache.ready && !this.disposed;
  }

  /** No time-driven animations — card drags repaint on pointer events. */
  animating(): boolean {
    return false;
  }

  /** A blinking edit caret is visible — serviced at the idle cadence. */
  wantsBlink(): boolean {
    return this.active && this.editing !== null && !this.disposed;
  }

  render(pass: GPURenderPassEncoder, surfaceW: number, surfaceH: number): void {
    if (this.rect.w <= 0) return;
    const p = this.pass;
    const t = this.t();
    p.begin();

    const ranges: { start: number; end: number; scissor?: [number, number, number, number] }[] =
      [{ start: 0, end: -1 }];

    const bg = hex(t.bg);
    p.rect(this.rect.x, this.rect.y, this.rect.w, this.rect.h, bg);

    // Page header.
    const title = this.pageTitle();
    this.text(this.rect.x + COL_X, this.rect.y + 6, "inter:600:normal", 20, title, hex(t.text));
    const sub = `${this.board.columns.length} lists · ${this.board.columns.reduce((n, c) => n + c.cards.length, 0)} cards`;
    this.text(this.rect.x + COL_X + this.measure("inter:600:normal", 20, title) + 14,
      this.rect.y + 10, "inter:400:normal", 12, sub, hex(t.textFaint));
    ranges[0]!.end = p.quadCount;

    for (let i = 0; i < this.board.columns.length; i++) {
      const col = this.board.columns[i]!;
      const cx = this.colX(i);
      const cy = this.rect.y + COL_TOP;
      const ch = this.colH(col);
      if (cx + COL_W < this.rect.x || cx > this.rect.x + this.rect.w) continue;

      // Column shell — unclipped.
      ranges.push({ start: p.quadCount, end: -1 });
      p.roundedRect(cx, cy, COL_W, ch, 10, hex(t.bgPanel));
      // Header: dot, title, count, +.
      const dot = COL_DOT[col.color % COL_DOT.length]!;
      p.roundedRect(cx + 12, cy + 13, 8, 8, 4, dot);
      const titleStr = this.editing?.cardId === null && this.editing.colId === col.id
        ? this.editing.text : col.title;
      this.text(cx + 26, cy + 8, "inter:600:normal", 13, titleStr || " ", hex(t.text));
      const count = `${col.cards.length}`;
      const cw = this.measure("inter:500:normal", 11, count) + 12;
      p.roundedRect(cx + COL_W - cw - 34, cy + 9, cw, 16, 8, hex(t.bgHover));
      this.text(cx + COL_W - cw - 34 + 6, cy + 10, "inter:500:normal", 11, count, hex(t.textDim));
      p.roundedRect(cx + COL_W - 28, cy + 9, 18, 16, 4, hex(t.bgHover));
      this.text(cx + COL_W - 23, cy + 10, "inter:400:normal", 11, "+", hex(t.textDim));
      // Caret on column title edit.
      if (this.editing?.cardId === null && this.editing.colId === col.id && this.blinkT % 1 < 0.53) {
        const tw = this.measure("inter:600:normal", 13, this.editing.text);
        p.rect(cx + 26 + tw + 1, cy + 9, 1.5, 15, hex(t.accent));
      }
      ranges[ranges.length - 1]!.end = p.quadCount;

      // Cards — clipped to the column's body region.
      const bodyY = cy + HEADER_H;
      const bodyH = ch - HEADER_H - ADD_H;
      const bodyScissor: [number, number, number, number] = [cx, bodyY, COL_W, bodyH];
      ranges.push({ start: p.quadCount, end: -1, scissor: bodyScissor });

      for (const g of this.cardGeoms(i)) {
        if (this.drag?.started && this.drag.card.id === g.card.id) continue; // floats
        const editingThis = this.editing?.cardId === g.card.id;
        p.roundedRect(g.x, g.y, g.w, g.h, 8, hex(editingThis ? t.bgActive : t.bgElev));
        p.roundedRect(g.x, g.y, g.w, g.h, 8, [0, 0, 0, 0]); // border hint via inner line
        if (this.hoverCard === g.card.id && !editingThis) {
          p.roundedRect(g.x, g.y, g.w, g.h, 8, hex(t.accentSoft));
        }
        const shown = editingThis ? this.editing!.text : g.card.title;
        if (shown || editingThis) {
          this.text(g.x + CARD_PAD, g.y + CARD_PAD - 1, "inter:500:normal", 13, shown || " ", hex(t.text));
        } else {
          this.text(g.x + CARD_PAD, g.y + CARD_PAD - 1, "inter:400:normal", 13, "New card", hex(t.textFaint));
        }
        if (editingThis && this.blinkT % 1 < 0.53) {
          const tw = this.measure("inter:500:normal", 13, shown);
          p.rect(g.x + CARD_PAD + tw + 1, g.y + CARD_PAD, 1.5, 15, hex(t.accent));
        }
        let ty = g.y + CARD_PAD + 20;
        if (g.card.desc) {
          for (const line of this.descLines(g.card)) {
            this.text(g.x + CARD_PAD, ty, "inter:400:normal", 12, line, hex(t.textDim));
            ty += 16;
          }
          ty += 4;
        }
        if (g.card.tags.length > 0) {
          let tx = g.x + CARD_PAD;
          for (const tag of g.card.tags) {
            const tw2 = this.measure("inter:500:normal", 10, tag) + 12;
            const ci2 = Math.abs(hashStr(tag)) % TAG_COLORS.length;
            p.roundedRect(tx, ty, tw2, 16, 8, TAG_COLORS[ci2]!);
            this.text(tx + 6, ty + 1, "inter:500:normal", 10, tag, [1, 1, 1, 0.85]);
            tx += tw2 + 6;
          }
        }
      }

      // Drop indicator.
      if (this.drag?.started && this.drag.targetCol === col.id) {
        const geoms = this.cardGeoms(i).filter(g => g.card.id !== this.drag!.card.id);
        const idx = Math.min(this.drag.targetIdx, geoms.length);
        let iy = bodyY + 4;
        if (idx >= geoms.length && geoms.length > 0) {
          const last = geoms[geoms.length - 1]!;
          iy = last.y + last.h + CARD_GAP - 3;
        } else if (idx < geoms.length) {
          iy = geoms[idx]!.y - CARD_GAP + 2;
        }
        p.roundedRect(cx + 8, iy, COL_W - 16, 3, 1.5, hex(t.accent));
      }
      ranges[ranges.length - 1]!.end = p.quadCount;

      // Add-card strip — unclipped.
      ranges.push({ start: p.quadCount, end: -1 });
      const addY = cy + ch - ADD_H;
      p.roundedRect(cx + 8, addY + 3, COL_W - 16, ADD_H - 6, 6, hex(t.bgPanel));
      this.text(cx + 16, addY + 7, "inter:400:normal", 12, "+  Add card", hex(t.textFaint));
      ranges[ranges.length - 1]!.end = p.quadCount;
    }

    // "+ Add list" ghost column.
    {
      const ax = this.colX(this.board.columns.length);
      const ay = this.rect.y + COL_TOP;
      ranges.push({ start: p.quadCount, end: -1 });
      p.roundedRect(ax, ay, COL_W, 40, 10, hex(t.bgPanel));
      this.text(ax + 14, ay + 12, "inter:500:normal", 13, "+  Add list", hex(t.textDim));
      ranges[ranges.length - 1]!.end = p.quadCount;
    }

    // Floating drag card — on top, unclipped.
    if (this.drag?.started) {
      const d = this.drag;
      ranges.push({ start: p.quadCount, end: -1 });
      const fx = d.x - d.grabX, fy = d.y - d.grabY;
      // Shadow.
      p.roundedRect(fx + 3, fy + 5, d.w, d.h, 8, [0, 0, 0, 0.35]);
      p.roundedRect(fx, fy, d.w, d.h, 8, hex(t.bgActive));
      p.roundedRect(fx, fy, d.w, 3, 2, hex(t.accent));
      this.text(fx + CARD_PAD, fy + CARD_PAD - 1, "inter:500:normal", 13, d.card.title || " ", hex(t.text));
      ranges[ranges.length - 1]!.end = p.quadCount;
    }

    for (const r of ranges) if (r.end < 0) r.end = p.quadCount;
    p.renderRanges(pass, surfaceW, surfaceH, this.atlas, this.time, ranges);
  }

  private pageTitle(): string {
    const s = store.getState();
    const p = s.activePageId ? s.pages[s.activePageId] : null;
    return (p?.title || "Board").trim();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.pass.destroy();
  }
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
