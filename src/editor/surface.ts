// ============================================================================
// surface.ts — the custom GPU editor surface.
//
// A ScreenUiCompositor drawn underneath the html-ui chrome (order -10):
// owns the run cache/atlas/quad pass, lays out the document, renders
// visible lines + decorations + selection + animated caret, and handles
// pointer/wheel/key input inside its rect.
//
// Coordinates: surface pixels (y-down), same space the input bus reports.
// Document space = surface coords minus origin, plus scroll.
// ============================================================================

import type { ScreenUiCompositor, RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import { GpuTextPass, type Rgba } from "../text/gpu-text";
import { TextAtlas } from "../text/atlas";
import { RunCache } from "../text/run-cache";
import { DocLayouter, type DocLayout, type EditorTheme } from "./layout";
import { docCompare, type Doc, type DocPos } from "./model";
import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger();

const PAD_X = 56;
const PAD_TOP = 28;
const SCROLL_LERP = 14;   // /s — exponential smoothing rate
const CARET_LERP = 22;

export interface EditorRect { x: number; y: number; w: number; h: number }

export class EditorSurface implements ScreenUiCompositor {
  order = -10;
  private pass: GpuTextPass;
  private atlas: TextAtlas;
  private cache: RunCache;
  private layouter: DocLayouter;
  private doc: Doc = { blocks: [] };
  private layout: DocLayout | null = null;
  private rect: EditorRect = { x: 0, y: 0, w: 0, h: 0 };
  private theme: EditorTheme;
  private unsubs: (() => void)[] = [];
  private textInputUnsub: (() => void) | null = null;
  private disposed = false;

  // Interaction state.
  caret: DocPos = { block: 0, offset: 0 };
  private anchor: DocPos | null = null;
  private focused = false;
  private scrollY = 0;
  private scrollTarget = 0;
  private caretX = 0;
  private caretY = 0;
  private caretH = 20;
  private caretShownX = 0;
  private caretShownY = 0;
  private blinkT = 0;
  private goalX: number | null = null;
  private dragging = false;
  private lastTime = 0;
  private dirty = true;
  private time = 0;

  onChange: (() => void) | null = null;

  constructor(private ctx: RendererModuleContext) {
    const device = ctx.getDevice();
    this.pass = new GpuTextPass(device, ctx.getFormat());
    this.atlas = new TextAtlas(device, 2048);
    this.cache = new RunCache(this.atlas);
    this.layouter = new DocLayouter(this.cache);
    this.theme = darkTheme();
    this.installInput();
  }

  get ready(): boolean {
    return this.cache.ready;
  }

  get runCache(): RunCache {
    return this.cache;
  }

  async init(): Promise<void> {
    await this.cache.init();
  }

  setTheme(theme: EditorTheme): void {
    this.theme = theme;
    this.dirty = true;
  }

  setRect(r: EditorRect): void {
    if (r.x === this.rect.x && r.y === this.rect.y && r.w === this.rect.w && r.h === this.rect.h) return;
    this.rect = r;
    this.dirty = true;
  }

  setDoc(doc: Doc): void {
    this.doc = doc;
    this.caret = { block: 0, offset: 0 };
    this.anchor = null;
    this.dirty = true;
  }

  get document(): Doc {
    return this.doc;
  }

  /** Whether native text input was successfully enabled — when true, real
   *  typing arrives via "textinput" events and keydown chars are ignored
   *  (they'd double-insert). MCP/synthetic typing still works via
   *  insertTextPublic. */
  private textInputActive = false;

  /** Start native text input so typing produces textinput events. */
  enableTextInput(): void {
    const win = (globalThis as { window?: { startTextInput?: () => void; addEventListener?: (t: string, f: (e: unknown) => void) => void; removeEventListener?: (t: string, f: (e: unknown) => void) => void } }).window;
    try {
      if (win?.startTextInput) {
        win.startTextInput();
        this.textInputActive = true;
      }
      const onText = (e: unknown) => {
        const text = (e as { text?: string }).text;
        if (text && this.focused) this.insertText(text);
      };
      win?.addEventListener?.("textinput", onText);
      this.textInputUnsub = () => win?.removeEventListener?.("textinput", onText);
    } catch (e) {
      log.warn("editor", `text input unavailable: ${e}`);
    }
  }

  /** Public text insertion (MCP/type_text tool). */
  insertTextPublic(text: string): void {
    this.insertText(text);
  }

  // ── Input ────────────────────────────────────────────────────────────────

  private installInput(): void {
    const bus = this.ctx.getInputBus();
    const inRect = (x: number, y: number) =>
      x >= this.rect.x && x <= this.rect.x + this.rect.w &&
      y >= this.rect.y && y <= this.rect.y + this.rect.h;

    this.unsubs.push(bus.onPointerDown((e, ctrl) => {
      if (!inRect(e.clientX, e.clientY)) {
        if (this.focused) { this.focused = false; this.dirty = true; }
        return;
      }
      ctrl.stopPropagation();
      this.focused = true;
      this.dragging = true;
      const pos = this.posAtSurface(e.clientX, e.clientY);
      if (e.shiftKey && this.anchor === null) this.anchor = { ...this.caret };
      if (e.shiftKey) {
        this.caret = pos;
      } else {
        this.caret = pos;
        this.anchor = null;
      }
      this.blinkT = 0;
      this.goalX = null;
      this.dirty = true;
    }, 50));

    this.unsubs.push(bus.onDrag((_d, ctrl) => {
      // Pointer-move already tracks drag-selection; just claim the gesture
      // so camera-style handlers don't fight us.
      if (!this.dragging) return;
      ctrl.stopPropagation();
    }, 50));

    this.unsubs.push(bus.onPointerMove((e, ctrl) => {
      if (!this.dragging) return;
      ctrl.stopPropagation();
      if (this.anchor === null) this.anchor = { ...this.caret };
      this.caret = this.posAtSurface(e.clientX, e.clientY);
      this.dirty = true;
    }, 50));

    this.unsubs.push(bus.onPointerUp((_e, ctrl) => {
      if (!this.dragging) return;
      ctrl.stopPropagation();
      this.dragging = false;
    }, 50));

    this.unsubs.push(bus.onWheel((e, ctrl) => {
      if (!inRect(e.clientX, e.clientY)) return;
      ctrl.stopPropagation();
      const max = Math.max(0, (this.layout?.height ?? 0) + PAD_TOP * 2 - this.rect.h);
      this.scrollTarget = clamp(this.scrollTarget + e.deltaY, 0, max);
    }, 50));

    this.unsubs.push(bus.onKeyDown((e, ctrl) => {
      if (!this.focused) return;
      if (this.handleKey(e)) ctrl.stopPropagation();
    }, 50));
  }

  private posAtSurface(sx: number, sy: number): DocPos {
    if (!this.layout) return { block: 0, offset: 0 };
    const dx = sx - this.rect.x - PAD_X;
    const dy = sy - this.rect.y + this.scrollY - PAD_TOP;
    return this.layouter.posAt(this.layout, dx, dy);
  }

  // ── Editing ─────────────────────────────────────────────────────────────

  private blockOf(pos: DocPos) {
    return this.doc.blocks[clamp(pos.block, 0, Math.max(0, this.doc.blocks.length - 1))];
  }

  private insertText(text: string): void {
    if (this.anchor !== null) this.deleteSelection();
    const b = this.blockOf(this.caret);
    if (!b) return;
    // Insert into the span at caret offset (extend last span if at end).
    let off = 0;
    for (let i = 0; i < b.spans.length; i++) {
      const sp = b.spans[i]!;
      if (this.caret.offset <= off + sp.text.length || i === b.spans.length - 1) {
        const inner = clamp(this.caret.offset - off, 0, sp.text.length);
        sp.text = sp.text.slice(0, inner) + text + sp.text.slice(inner);
        this.caret = { block: this.caret.block, offset: off + inner + text.length };
        this.dirty = true;
        this.blinkT = 0;
        this.onChange?.();
        return;
      }
      off += sp.text.length;
    }
    if (b.spans.length === 0) {
      // Empty block — need a style; inherit paragraph defaults.
      b.spans.push({ text, style: { family: "inter", weight: 400, italic: false, sizePx: 16, color: this.theme.text } });
      this.caret = { block: this.caret.block, offset: text.length };
      this.dirty = true;
      this.blinkT = 0;
      this.onChange?.();
    }
  }

  private deleteSelection(): void {
    if (this.anchor === null) return;
    const a = docCompare(this.anchor, this.caret) <= 0 ? this.anchor : this.caret;
    const b = docCompare(this.anchor, this.caret) <= 0 ? this.caret : this.anchor;
    // Simple path: same-block delete; cross-block merges into block a.
    const ba = this.doc.blocks[a.block];
    if (!ba) { this.anchor = null; return; }
    if (a.block === b.block) {
      spliceSpans(ba, a.offset, b.offset - a.offset);
    } else {
      const tail = takeSpansFrom(this.doc.blocks[b.block]!, b.offset);
      spliceSpans(ba, a.offset, Infinity);
      ba.spans.push(...tail);
      this.doc.blocks.splice(a.block + 1, b.block - a.block);
    }
    this.caret = a;
    this.anchor = null;
    this.dirty = true;
    this.blinkT = 0;
    this.onChange?.();
  }

  private backspace(): void {
    if (this.anchor !== null) { this.deleteSelection(); return; }
    if (this.caret.offset > 0) {
      const b = this.blockOf(this.caret);
      spliceSpans(b, this.caret.offset - 1, 1);
      this.caret = { ...this.caret, offset: this.caret.offset - 1 };
    } else if (this.caret.block > 0) {
      const prev = this.doc.blocks[this.caret.block - 1]!;
      const prevLen = prev.spans.reduce((n, s) => n + s.text.length, 0);
      const cur = this.doc.blocks.splice(this.caret.block, 1)[0]!;
      prev.spans.push(...cur.spans);
      this.caret = { block: this.caret.block - 1, offset: prevLen };
    }
    this.dirty = true;
    this.blinkT = 0;
    this.onChange?.();
  }

  private splitBlock(): void {
    if (this.anchor !== null) this.deleteSelection();
    const b = this.blockOf(this.caret);
    if (!b) return;
    const tail = takeSpansFrom(b, this.caret.offset);
    const kind = (b.kind === "bullet" || b.kind === "number" || b.kind === "todo") ? b.kind : "paragraph";
    this.doc.blocks.splice(this.caret.block + 1, 0, {
      id: `${b.id}s${Date.now().toString(36)}`, kind, spans: tail,
    });
    this.caret = { block: this.caret.block + 1, offset: 0 };
    this.dirty = true;
    this.blinkT = 0;
    this.onChange?.();
  }

  private handleKey(e: KeyboardEvent): boolean {
    const k = e.key;
    if (e.ctrlKey || e.metaKey) {
      const key = (k ?? "").toLowerCase();
      if (key === "a") { this.selectAll(); return true; }
      // Clipboard wiring lands with the workspace layer.
      return false;
    }
    switch (k) {
      case "Backspace": this.backspace(); return true;
      case "Delete": this.forwardDelete(); return true;
      case "Enter": this.splitBlock(); return true;
      case "ArrowLeft": this.moveCaret(-1, e.shiftKey); return true;
      case "ArrowRight": this.moveCaret(1, e.shiftKey); return true;
      case "ArrowUp": this.moveLine(-1, e.shiftKey); return true;
      case "ArrowDown": this.moveLine(1, e.shiftKey); return true;
      case "Home": this.moveHome(e.shiftKey); return true;
      case "End": this.moveEnd(e.shiftKey); return true;
      case "Tab": this.insertText("  "); return true;
      default:
        // Fallback typing when native text input is unavailable (synthetic
        // key events — e.g. MCP — never produce textinput events).
        if (!this.textInputActive && k && k.length === 1) {
          this.insertText(k);
          return true;
        }
        return false;
    }
  }

  private forwardDelete(): void {
    if (this.anchor !== null) { this.deleteSelection(); return; }
    const b = this.blockOf(this.caret);
    const len = b ? b.spans.reduce((n, s) => n + s.text.length, 0) : 0;
    if (this.caret.offset < len) {
      spliceSpans(b!, this.caret.offset, 1);
    } else if (this.caret.block + 1 < this.doc.blocks.length) {
      const next = this.doc.blocks.splice(this.caret.block + 1, 1)[0]!;
      b!.spans.push(...next.spans);
    }
    this.dirty = true;
    this.blinkT = 0;
    this.onChange?.();
  }

  private selectAll(): void {
    if (this.doc.blocks.length === 0) return;
    this.anchor = { block: 0, offset: 0 };
    const last = this.doc.blocks.length - 1;
    this.caret = { block: last, offset: this.doc.blocks[last]!.spans.reduce((n, s) => n + s.text.length, 0) };
    this.dirty = true;
  }

  private extendSelection(extend: boolean): void {
    if (extend) {
      if (this.anchor === null) this.anchor = { ...this.caret };
    } else {
      this.anchor = null;
    }
  }

  private moveCaret(dir: -1 | 1, shift: boolean): void {
    this.extendSelection(shift);
    if (!shift && this.anchor !== null) this.anchor = null;
    const b = this.blockOf(this.caret);
    const len = b ? b.spans.reduce((n, s) => n + s.text.length, 0) : 0;
    let { block, offset } = this.caret;
    offset += dir;
    if (offset < 0 && block > 0) {
      block--;
      offset = this.doc.blocks[block]!.spans.reduce((n, s) => n + s.text.length, 0);
    } else if (offset > len && block + 1 < this.doc.blocks.length) {
      block++;
      offset = 0;
    }
    this.caret = { block, offset: Math.max(0, offset) };
    this.goalX = null;
    this.blinkT = 0;
    this.dirty = true;
  }

  private moveLine(dir: -1 | 1, shift: boolean): void {
    if (!this.layout) return;
    this.extendSelection(shift);
    const li = this.layouter.lineIndexOf(this.layout, this.caret);
    if (li < 0) return;
    const target = this.layout.lines[clamp(li + dir, 0, this.layout.lines.length - 1)]!;
    const cr = this.layouter.caretRect(this.layout, this.caret);
    const gx = this.goalX ?? cr.x;
    this.caret = { block: target.block, offset: this.layouter.offsetNearX(target, gx) };
    this.goalX = gx;
    this.blinkT = 0;
    this.dirty = true;
  }

  private moveHome(shift: boolean): void {
    if (!this.layout) return;
    this.extendSelection(shift);
    const li = this.layouter.lineIndexOf(this.layout, this.caret);
    const line = this.layout.lines[Math.max(0, li)]!;
    this.caret = { block: line.block, offset: line.blockStart };
    this.blinkT = 0;
    this.dirty = true;
  }

  private moveEnd(shift: boolean): void {
    if (!this.layout) return;
    this.extendSelection(shift);
    const li = this.layouter.lineIndexOf(this.layout, this.caret);
    const line = this.layout.lines[Math.max(0, li)]!;
    this.caret = { block: line.block, offset: line.blockEnd };
    this.blinkT = 0;
    this.dirty = true;
  }

  // ── Frame ────────────────────────────────────────────────────────────────

  /** Advance animations; returns true while animating (caller may request frames). */
  tick(dt: number): void {
    this.time += dt;
    if (this.lastTime === 0) this.lastTime = dt;
    this.scrollY += (this.scrollTarget - this.scrollY) * Math.min(1, dt * SCROLL_LERP);
    if (Math.abs(this.scrollTarget - this.scrollY) < 0.1) this.scrollY = this.scrollTarget;
    this.blinkT += dt;

    if (this.layout) {
      const r = this.layouter.caretRect(this.layout, this.caret);
      this.caretX = r.x; this.caretY = r.y; this.caretH = r.h;
      const snap = this.caretShownX === 0 && this.caretShownY === 0;
      const k = Math.min(1, dt * CARET_LERP);
      this.caretShownX += (this.caretX - this.caretShownX) * k;
      this.caretShownY += (this.caretY - this.caretShownY) * k;
      if (snap) { this.caretShownX = this.caretX; this.caretShownY = this.caretY; }
      // Keep caret visible.
      const cy = this.caretY + PAD_TOP;
      const vis = this.rect.h - PAD_TOP;
      if (cy - this.scrollY > vis) this.scrollTarget = cy - vis + 8;
      if (cy - this.scrollY < PAD_TOP) this.scrollTarget = Math.max(0, cy - PAD_TOP - 8);
    }
    if (this.dirty && this.rect.w > 0 && this.cache.ready) {
      this.layout = this.layouter.layout(this.doc, Math.max(80, this.rect.w - PAD_X * 2), this.theme);
      this.dirty = false;
    }
  }

  hasContent(): boolean {
    return this.cache.ready && !this.disposed;
  }

  render(pass: GPURenderPassEncoder, surfaceW: number, surfaceH: number): void {
    if (!this.layout || this.rect.w <= 0) return;
    const p = this.pass;
    const t = this.theme;
    p.begin();

    const ox = this.rect.x + PAD_X;
    const oy = this.rect.y + PAD_TOP - this.scrollY;
    const viewTop = this.rect.y;
    const viewBot = this.rect.y + this.rect.h;

    // Block-level decorations first (bg must not cover earlier lines' text).
    for (const lb of this.layout.blocks) {
      const by = oy + lb.y;
      if (by + lb.height < viewTop || by > viewBot) continue;
      const block = this.doc.blocks[lb.block]!;
      if (block.kind === "codeblock") {
        p.roundedRect(this.rect.x + 8, by - 4, this.rect.w - 16, lb.height + 8, 8, t.codeBg);
      } else if (block.kind === "callout") {
        p.roundedRect(this.rect.x + 8, by - 4, this.rect.w - 16, lb.height + 8, 8, [0.16, 0.19, 0.28, 1]);
      } else if (block.kind === "quote") {
        p.roundedRect(ox - 20, by + 4, 3, lb.height - 8, 1.5, t.quoteBar);
      }
    }

    // Visible lines.
    for (const line of this.layout.lines) {
      const ly = oy + line.y;
      if (ly + line.height < viewTop || ly > viewBot) continue;

      const block = this.doc.blocks[line.block]!;
      if (line.segments.length === 0 && block.kind !== "divider") continue;

      switch (block.kind) {
        case "divider":
          p.rect(ox, ly + line.height / 2 - 0.5, this.rect.w - PAD_X * 2, 1, t.divider);
          break;
        case "bullet":
          p.roundedRect(ox - 17, line.baseline + oy - 3, 6, 6, 3, t.bulletColor);
          break;
        case "number": {
          const label = `${block.num ?? 1}.`;
          const chunk = this.cache.getChunk("inter:400:normal", 16, label);
          if (chunk?.region) {
            p.text(ox - 22 - chunk.w, line.baseline + oy - chunk.baselineInBitmap,
              chunk.w, chunk.h, { region: chunk.region, atlasSize: this.atlas.size }, t.bulletColor);
          }
          break;
        }
        default:
          break;
      }

      for (const seg of line.segments) {
        const text = seg.runText.slice(seg.start, seg.end);
        if (!text) continue;
        const chunk = this.cache.getChunk(seg.faceKey, seg.sizePx, text);
        if (!chunk || !chunk.region) continue;
        const penX = ox + seg.x;
        const imgX = penX + chunk.inkX;
        const imgY = oy + line.baseline - chunk.baselineInBitmap;
        const color = seg.style.code && this.doc.blocks[line.block]!.kind !== "codeblock" ? t.codeText : seg.style.color;
        p.text(imgX, imgY, chunk.w, chunk.h, { region: chunk.region, atlasSize: this.atlas.size }, color);

        // Decorations.
        const segW = (seg.run.clusterOffsets[seg.end] ?? 0) - (seg.run.clusterOffsets[seg.start] ?? 0);
        if (seg.style.code && this.doc.blocks[line.block]!.kind !== "codeblock") {
          p.roundedRect(penX - 4, ly + line.height * 0.12, segW + 8, line.height * 0.76, 5, t.codeBg);
        }
        if (seg.style.underline) {
          p.rect(penX, oy + line.baseline + 2, segW, 1.5, seg.style.color);
        }
        if (seg.style.strikethrough) {
          p.rect(penX, oy + line.baseline - seg.run.ascent * 0.32, segW, 1.5, seg.style.color);
        }
      }
    }

    // Selection.
    if (this.anchor !== null) {
      const rects = this.layouter.selectionRects(this.layout, this.anchor, this.caret);
      for (const r of rects) {
        p.rect(ox + r.x, oy + r.y, Math.max(2, r.w), r.h, t.selection);
      }
    }

    // Caret — blink: 0.53s on / 0.47s off.
    if (this.focused && this.blinkT % 1.0 < 0.53) {
      p.roundedRect(ox + this.caretShownX - 1, oy + this.caretShownY, 2, this.caretH, 1, t.caret);
    }

    p.render(pass, surfaceW, surfaceH, this.atlas, this.time);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.textInputUnsub?.();
    this.cache.dispose();
    this.atlas.destroy();
    this.pass.destroy();
  }
}

// ── Span splicing helpers ────────────────────────────────────────────────────

type SpanLike = { text: string; style: import("./model").TextStyle };

/** Remove `count` utf16 units starting at `off` across a block's spans. */
function spliceSpans(b: { spans: SpanLike[] }, off: number, count: number): void {
  let pos = 0;
  let remaining = count;
  const out: SpanLike[] = [];
  for (const sp of b.spans) {
    const s0 = pos;
    const s1 = pos + sp.text.length;
    if (remaining <= 0 || off >= s1 || off + remaining <= s0) {
      out.push(sp);
    } else {
      const keepStart = Math.max(0, off - s0);
      const delEnd = Math.min(sp.text.length, off + remaining - s0);
      const text = sp.text.slice(0, keepStart) + sp.text.slice(delEnd);
      if (text) out.push({ text, style: sp.style });
      remaining -= delEnd - keepStart;
    }
    pos = s1;
  }
  b.spans = out;
}

/** Detach and return all span content from `off` to end (mutates block). */
function takeSpansFrom(b: { spans: SpanLike[] }, off: number): SpanLike[] {
  const tail: SpanLike[] = [];
  let pos = 0;
  const keep: SpanLike[] = [];
  for (const sp of b.spans) {
    const s1 = pos + sp.text.length;
    if (off >= s1) { keep.push(sp); }
    else if (off <= pos) { tail.push(sp); }
    else {
      keep.push({ text: sp.text.slice(0, off - pos), style: sp.style });
      tail.push({ text: sp.text.slice(off - pos), style: sp.style });
    }
    pos = s1;
  }
  b.spans = keep;
  return tail;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function darkTheme(): EditorTheme {
  return {
    text: [0.82, 0.84, 0.90, 1],
    textMuted: [0.55, 0.57, 0.64, 1],
    caret: [0.45, 0.62, 0.98, 1],
    selection: [0.30, 0.42, 0.75, 0.35],
    codeBg: [0.13, 0.14, 0.18, 1],
    codeText: [0.78, 0.82, 0.95, 1],
    quoteBar: [0.45, 0.62, 0.98, 0.9],
    divider: [0.28, 0.30, 0.36, 1],
    bulletColor: [0.55, 0.57, 0.64, 1],
  };
}

export function lightTheme(): EditorTheme {
  return {
    text: [0.16, 0.17, 0.21, 1],
    textMuted: [0.45, 0.47, 0.52, 1],
    caret: [0.20, 0.42, 0.95, 1],
    selection: [0.35, 0.55, 0.98, 0.25],
    codeBg: [0.93, 0.94, 0.96, 1],
    codeText: [0.25, 0.28, 0.50, 1],
    quoteBar: [0.20, 0.42, 0.95, 0.9],
    divider: [0.82, 0.83, 0.87, 1],
    bulletColor: [0.45, 0.47, 0.52, 1],
  };
}
