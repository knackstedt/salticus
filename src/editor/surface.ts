// ============================================================================
// surface.ts — the custom GPU editor surface.
//
// A ScreenUiCompositor drawn underneath the html-ui chrome (order -10):
// owns the run cache/atlas/quad pass, lays out the document, renders
// visible lines + decorations + selection + animated caret + overlays
// (slash menu, format toolbar), and handles pointer/wheel/key input.
//
// Coordinates: surface pixels (y-down), same space the input bus reports.
// Document space = surface coords minus origin, plus scroll.
// ============================================================================

import type { ScreenUiCompositor, RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import { GpuTextPass, type Rgba } from "../text/gpu-text";
import { TextAtlas } from "../text/atlas";
import { RunCache } from "../text/run-cache";
import { DocLayouter, type DocLayout, type EditorTheme } from "./layout";
import { docCompare, blockText, newBlockId, type Block, type Doc, type DocPos, type Span, type TextStyle } from "./model";
import { History } from "./history";
import { matchBlockShortcut, matchInlineShortcut, inlineMarkerLen, stripBlockPrefix, styleRange } from "./markdown";
import { darkSyntax, lightSyntax } from "./highlight";
import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger();

const PAD_X = 56;
const PAD_TOP = 28;
const SCROLL_LERP = 14;   // /s — exponential smoothing rate
const CARET_LERP = 22;

export interface EditorRect { x: number; y: number; w: number; h: number }

// ── Slash menu ──────────────────────────────────────────────────────────────

interface SlashItem { kind: Block["kind"]; label: string; hint: string; kw: string }
const SLASH_ITEMS: SlashItem[] = [
  { kind: "paragraph", label: "Text", hint: "Plain paragraph", kw: "text paragraph plain p" },
  { kind: "h1", label: "Heading 1", hint: "Big section title", kw: "h1 heading title" },
  { kind: "h2", label: "Heading 2", hint: "Section heading", kw: "h2 heading" },
  { kind: "h3", label: "Heading 3", hint: "Sub heading", kw: "h3 heading" },
  { kind: "bullet", label: "Bulleted list", hint: "Unordered list", kw: "bullet list ul" },
  { kind: "number", label: "Numbered list", hint: "Ordered list", kw: "number list ol ordered" },
  { kind: "todo", label: "To-do", hint: "Checkbox task", kw: "todo task checkbox check" },
  { kind: "quote", label: "Quote", hint: "Block quote", kw: "quote blockquote" },
  { kind: "codeblock", label: "Code", hint: "Code block", kw: "code block pre" },
  { kind: "divider", label: "Divider", hint: "Horizontal rule", kw: "divider rule hr line" },
  { kind: "callout", label: "Callout", hint: "Highlighted note", kw: "callout note info" },
];

interface SlashState {
  block: number;
  slashOffset: number;
  index: number;
  items: SlashItem[];
  /** Screen-space rect — set during render for hit testing. */
  rect: { x: number; y: number; w: number; h: number } | null;
}

// ── Format toolbar ──────────────────────────────────────────────────────────

interface ToolbarBtn { id: string; label: string; w: number }
const TOOLBAR_BTNS: ToolbarBtn[] = [
  { id: "bold", label: "B", w: 30 },
  { id: "italic", label: "I", w: 28 },
  { id: "underline", label: "U", w: 30 },
  { id: "strike", label: "S", w: 30 },
  { id: "code", label: "</>", w: 36 },
];

interface ToolbarState {
  rect: { x: number; y: number; w: number; h: number };
}

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
  private history = new History();
  private slash: SlashState | null = null;
  private toolbar: ToolbarState | null = null;

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
  private dirty = true;
  private time = 0;
  private textInputActive = false;

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

  get hasFocus(): boolean {
    return this.focused;
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
    this.history.clear();
    this.slash = null;
    this.toolbar = null;
    this.dirty = true;
  }

  get document(): Doc {
    return this.doc;
  }

  /** Whether native text input was enabled (real typing via textinput). */
  enableTextInput(): void {
    const win = (globalThis as {
      __nativeWindow?: {
        startTextInput?: () => void;
        setTextInputRect?: (x: number, y: number, w: number, h: number) => void;
      };
      window?: {
        addEventListener?: (t: string, f: (e: unknown) => void) => void;
        removeEventListener?: (t: string, f: (e: unknown) => void) => void;
      };
    });
    try {
      const nw = win.__nativeWindow;
      if (nw?.startTextInput) {
        nw.startTextInput();
        this.textInputActive = true;
      }
      const onText = (e: unknown) => {
        const text = (e as { text?: string }).text;
        if (text && this.focused) this.insertText(text);
      };
      win.window?.addEventListener?.("textinput", onText);
      this.textInputUnsub = () => win.window?.removeEventListener?.("textinput", onText);
    } catch (e) {
      log.warn("editor", `text input unavailable: ${e}`);
    }
  }

  /** Public text insertion (MCP type_text tool). */
  insertTextPublic(text: string): void {
    this.insertText(text);
  }

  focus(): void {
    this.focused = true;
    this.dirty = true;
  }

  // ── Input ────────────────────────────────────────────────────────────────

  private installInput(): void {
    const bus = this.ctx.getInputBus();
    const inRect = (x: number, y: number) =>
      x >= this.rect.x && x <= this.rect.x + this.rect.w &&
      y >= this.rect.y && y <= this.rect.y + this.rect.h;

    this.unsubs.push(bus.onPointerDown((e, ctrl) => {
      // Overlays eat their own clicks first.
      if (this.slash?.rect && inside(e.clientX, e.clientY, this.slash.rect)) {
        ctrl.stopPropagation();
        const idx = Math.floor((e.clientY - this.slash.rect.y - 6) / 30);
        if (idx >= 0 && idx < this.slash.items.length) this.applySlash(idx);
        return;
      }
      if (this.toolbar && inside(e.clientX, e.clientY, this.toolbar.rect)) {
        ctrl.stopPropagation();
        this.toolbarClick(e.clientX);
        return;
      }
      if (!inRect(e.clientX, e.clientY)) {
        if (this.focused) { this.focused = false; this.history.barrier(); this.dirty = true; }
        this.slash = null;
        return;
      }
      ctrl.stopPropagation();
      this.focused = true;
      this.slash = null;
      this.toolbar = null;

      // Todo checkbox hit?
      const pos = this.posAtSurface(e.clientX, e.clientY);
      if (this.tryToggleTodo(e.clientX, e.clientY)) {
        this.dragging = false;
        return;
      }
      this.dragging = true;
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
      // Show format toolbar over a non-empty selection.
      if (this.anchor !== null && docCompare(this.anchor, this.caret) !== 0) {
        this.showToolbar();
      }
    }, 50));

    this.unsubs.push(bus.onWheel((e, ctrl) => {
      if (!inRect(e.clientX, e.clientY)) return;
      ctrl.stopPropagation();
      const max = Math.max(0, (this.layout?.height ?? 0) + PAD_TOP * 2 - this.rect.h);
      this.scrollTarget = clamp(this.scrollTarget + e.deltaY, 0, max);
      this.toolbar = null;
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

  private tryToggleTodo(sx: number, sy: number): boolean {
    if (!this.layout) return false;
    const dx = sx - this.rect.x - PAD_X;
    const dy = sy - this.rect.y + this.scrollY - PAD_TOP;
    if (dx < -26 || dx > -2) return false; // marker column only
    for (const line of this.layout.lines) {
      if (dy < line.y || dy >= line.y + line.height) continue;
      const b = this.doc.blocks[line.block];
      if (b?.kind === "todo" && line.blockStart === 0) {
        this.history.push(this.doc.blocks, this.caret, this.anchor, "toggle");
        b.checked = !b.checked;
        this.dirty = true;
        this.onChange?.();
        return true;
      }
      return false;
    }
    return false;
  }

  // ── Editing ─────────────────────────────────────────────────────────────

  private blockOf(pos: DocPos): Block | undefined {
    return this.doc.blocks[clamp(pos.block, 0, Math.max(0, this.doc.blocks.length - 1))];
  }

  private mutate(kind: string): void {
    this.history.push(this.doc.blocks, this.caret, this.anchor, kind);
  }

  private inserted(): void {
    this.dirty = true;
    this.blinkT = 0;
    this.onChange?.();
  }

  private insertText(text: string): void {
    for (let ti = 0; ti < text.length; ti++) {
      const ch = text[ti]!;
      this.insertChar(ch);
    }
  }

  private insertChar(ch: string): void {
    // Slash menu stays open while its filter query grows.
    if (this.slash) {
      if (ch === "\n") { this.applySlash(this.slash.index); return; }
      this.mutate("type");
      this.insertRaw(ch);
      this.updateSlashQuery();
      return;
    }

    // "/" starts the slash menu at a word boundary.
    if (ch === "/") {
      const b = this.blockOf(this.caret);
      const before = b ? blockText(b).slice(0, this.caret.offset) : "";
      if (b && (before === "" || /\s$/.test(before)) && b.kind !== "codeblock") {
        this.mutate("type");
        this.insertRaw(ch);
        this.openSlash(this.caret.block, this.caret.offset - 1);
        this.inserted();
        return;
      }
    }

    if (ch === "\n") { this.splitBlock(); return; }

    if (ch === " ") {
      // Block shortcut? (text before caret is the marker only)
      const b = this.blockOf(this.caret);
      if (b && b.kind !== "codeblock") {
        const before = blockText(b).slice(0, this.caret.offset);
        const m = matchBlockShortcut(before, b.kind);
        if (m && this.caret.offset === before.length) {
          this.mutate("format");
          stripBlockPrefix(b, m.strip);
          b.kind = m.kind;
          m.apply?.(b);
          this.caret = { block: this.caret.block, offset: 0 };
          this.inserted();
          return;
        }
      }
      this.mutate("type");
      this.insertRaw(ch);
      this.checkInlineMarkdown();
      this.inserted();
      return;
    }

    this.mutate("type");
    this.insertRaw(ch);
    if (/^[.,;:!?)]$/.test(ch)) this.checkInlineMarkdown();
    this.inserted();
  }

  /** Raw single-char insert at caret (no markdown/slash handling). */
  private insertRaw(text: string): void {
    if (this.anchor !== null) this.deleteSelection(false);
    const b = this.blockOf(this.caret);
    if (!b) return;
    if (b.spans.length === 0) {
      b.spans.push({ text, style: { family: "inter", weight: 400, italic: false, sizePx: 16, color: this.theme.text } });
      this.caret = { block: this.caret.block, offset: text.length };
      return;
    }
    let off = 0;
    for (let i = 0; i < b.spans.length; i++) {
      const sp = b.spans[i]!;
      if (this.caret.offset <= off + sp.text.length || i === b.spans.length - 1) {
        const inner = clamp(this.caret.offset - off, 0, sp.text.length);
        sp.text = sp.text.slice(0, inner) + text + sp.text.slice(inner);
        this.caret = { block: this.caret.block, offset: off + inner + text.length };
        return;
      }
      off += sp.text.length;
    }
  }

  /** After a space/punct: wrap trailing `**x**`-style patterns into spans. */
  private checkInlineMarkdown(): void {
    const b = this.blockOf(this.caret);
    if (!b || b.kind === "codeblock") return;
    const text = blockText(b);
    // The trigger char sits just before the caret — the pattern ends before it.
    const scan = text.slice(0, this.caret.offset - 1);
    const m = matchInlineShortcut(scan);
    if (!m) return;
    const markerLen = inlineMarkerLen(scan);
    const innerStart = m.start + markerLen;
    const innerEnd = m.end - markerLen;
    if (innerStart >= innerEnd) return;
    spliceSpans(b, innerEnd, markerLen);
    spliceSpans(b, m.start, markerLen);
    styleRange(b, m.start, innerEnd - markerLen, m.style);
    this.caret = { block: this.caret.block, offset: this.caret.offset - markerLen * 2 };
  }

  private deleteSelection(mutate = true): void {
    if (this.anchor === null) return;
    if (mutate) this.mutate("delete");
    const a = docCompare(this.anchor, this.caret) <= 0 ? this.anchor : this.caret;
    const b = docCompare(this.anchor, this.caret) <= 0 ? this.caret : this.anchor;
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
    this.inserted();
  }

  private backspace(): void {
    if (this.anchor !== null) { this.deleteSelection(); return; }
    this.mutate("delete");
    if (this.caret.offset > 0) {
      const b = this.blockOf(this.caret);
      spliceSpans(b!, this.caret.offset - 1, 1);
      this.caret = { ...this.caret, offset: this.caret.offset - 1 };
    } else if (this.caret.block > 0) {
      const prev = this.doc.blocks[this.caret.block - 1]!;
      const prevLen = blockText(prev).length;
      const cur = this.doc.blocks.splice(this.caret.block, 1)[0]!;
      if (cur.kind !== "paragraph" && cur.spans.length > 0) {
        // Keep structural blocks: convert to paragraph, then merge text.
        cur.kind = "paragraph";
      }
      prev.spans.push(...cur.spans);
      this.caret = { block: this.caret.block - 1, offset: prevLen };
    } else {
      const b = this.blockOf(this.caret);
      if (b && b.kind !== "paragraph") {
        b.kind = "paragraph"; // backspace at start unstyles the block
      }
    }
    this.inserted();
  }

  private forwardDelete(): void {
    if (this.anchor !== null) { this.deleteSelection(); return; }
    this.mutate("delete");
    const b = this.blockOf(this.caret);
    const len = b ? blockText(b).length : 0;
    if (this.caret.offset < len) {
      spliceSpans(b!, this.caret.offset, 1);
    } else if (this.caret.block + 1 < this.doc.blocks.length) {
      const next = this.doc.blocks.splice(this.caret.block + 1, 1)[0]!;
      b!.spans.push(...next.spans);
    }
    this.inserted();
  }

  private splitBlock(): void {
    if (this.anchor !== null) this.deleteSelection(false);
    this.mutate("split");
    const b = this.blockOf(this.caret);
    if (!b) return;
    const tail = takeSpansFrom(b, this.caret.offset);
    let kind = b.kind;
    if (kind === "h1" || kind === "h2" || kind === "h3" || kind === "quote" || kind === "callout" || kind === "divider") {
      kind = "paragraph";
    }
    // In codeblocks, Enter inserts a newline INSIDE the block.
    if (b.kind === "codeblock") {
      this.insertRaw("\n");
      this.inserted();
      return;
    }
    const nb: Block = { id: newBlockId(), kind, spans: tail };
    if (kind === "todo") nb.checked = false;
    if (kind === "number") nb.num = (b.num ?? 1) + 1;
    this.doc.blocks.splice(this.caret.block + 1, 0, nb);
    if (blockText(b).length === 0 && b.kind !== "paragraph" && kind === "paragraph") {
      // Enter on an empty styled block → turn it into a paragraph instead.
      this.doc.blocks.splice(this.caret.block + 1, 1);
      b.kind = "paragraph";
      this.caret = { block: this.caret.block, offset: 0 };
    } else {
      this.caret = { block: this.caret.block + 1, offset: 0 };
    }
    this.inserted();
  }

  // ── Slash menu ────────────────────────────────────────────────────────────

  private openSlash(block: number, slashOffset: number): void {
    this.slash = { block, slashOffset, index: 0, items: SLASH_ITEMS, rect: null };
  }

  private updateSlashQuery(): void {
    if (!this.slash) return;
    const b = this.blockOf({ block: this.slash.block, offset: 0 });
    if (!b || this.caret.block !== this.slash.block) { this.slash = null; return; }
    const q = blockText(b).slice(this.slash.slashOffset + 1, this.caret.offset);
    if (!/^[\w ]*$/.test(q) || q.length > 24) { this.slash = null; return; }
    const lq = q.toLowerCase();
    const items = SLASH_ITEMS.filter((i) =>
      i.label.toLowerCase().includes(lq) || i.kw.includes(lq) || i.kind.includes(lq));
    if (items.length === 0) { this.slash = null; return; }
    this.slash.items = items;
    this.slash.index = clamp(this.slash.index, 0, items.length - 1);
    this.dirty = true;
  }

  private applySlash(idx: number): void {
    if (!this.slash) return;
    const item = this.slash.items[clamp(idx, 0, this.slash.items.length - 1)]!;
    const b = this.doc.blocks[this.slash.block];
    this.slash = null;
    if (!b) return;
    this.mutate("format");
    stripBlockPrefix(b, this.caret.offset); // remove "/query"
    b.kind = item.kind;
    if (item.kind === "todo") b.checked = false;
    if (item.kind === "number") b.num = 1;
    if (item.kind === "codeblock") b.lang = "ts";
    this.caret = { block: this.caret.block, offset: 0 };
    this.inserted();
  }

  // ── Format toolbar ────────────────────────────────────────────────────────

  private showToolbar(): void {
    if (!this.layout || this.anchor === null) return;
    const a = docCompare(this.anchor, this.caret) <= 0 ? this.anchor : this.caret;
    const rects = this.layouter.selectionRects(this.layout, a, this.caret);
    if (rects.length === 0) return;
    const top = rects[0]!;
    const w = TOOLBAR_BTNS.reduce((n, b) => n + b.w, 0) + 12;
    const x = clamp(this.rect.x + PAD_X + top.x, this.rect.x + 4, this.rect.x + this.rect.w - w - 4);
    const y = Math.max(this.rect.y + 4, this.rect.y + PAD_TOP - this.scrollY + top.y - 38);
    this.toolbar = { rect: { x, y, w, h: 32 } };
  }

  private toolbarClick(mx: number): void {
    if (!this.toolbar) return;
    let x = this.toolbar.rect.x + 6;
    for (const btn of TOOLBAR_BTNS) {
      if (mx >= x && mx < x + btn.w) {
        this.applyFormat(btn.id);
        return;
      }
      x += btn.w;
    }
  }

  private applyFormat(id: string): void {
    if (this.anchor === null) return;
    const patch: Partial<TextStyle> =
      id === "bold" ? { weight: 700 } :
      id === "italic" ? { italic: true } :
      id === "underline" ? { underline: true } :
      id === "strike" ? { strikethrough: true } :
      { code: true };
    this.mutate("format");
    const a = docCompare(this.anchor, this.caret) <= 0 ? this.anchor : this.caret;
    const b = docCompare(this.anchor, this.caret) <= 0 ? this.caret : this.anchor;
    for (let bi = a.block; bi <= b.block; bi++) {
      const blk = this.doc.blocks[bi]!;
      const s = bi === a.block ? a.offset : 0;
      const e = bi === b.block ? b.offset : blockText(blk).length;
      // Toggle: if fully styled already, strip instead.
      const already = rangeHasStyle(blk, s, e, id);
      const realPatch = already ? inversePatch(id) : patch;
      styleRange(blk, s, e, realPatch);
    }
    this.inserted();
  }

  // ── Clipboard ─────────────────────────────────────────────────────────────

  private clipboardText(): string {
    if (this.anchor === null) return "";
    const a = docCompare(this.anchor, this.caret) <= 0 ? this.anchor : this.caret;
    const b = docCompare(this.anchor, this.caret) <= 0 ? this.caret : this.anchor;
    if (a.block === b.block) {
      return blockText(this.doc.blocks[a.block]!).slice(a.offset, b.offset);
    }
    const parts: string[] = [];
    for (let i = a.block; i <= b.block; i++) {
      const blk = this.doc.blocks[i]!;
      const s = i === a.block ? a.offset : 0;
      const e = i === b.block ? b.offset : blockText(blk).length;
      parts.push(blockText(blk).slice(s, e));
    }
    return parts.join("\n");
  }

  private clipboardSet(text: string): void {
    const nw = (globalThis as { __nativeWindow?: { setClipboardText?: (t: string) => void } }).__nativeWindow;
    try { nw?.setClipboardText?.(text); } catch (e) { log.warn("editor", `clipboard set failed: ${e}`); }
  }

  private clipboardGet(): string {
    const nw = (globalThis as { __nativeWindow?: { getClipboardText?: () => string } }).__nativeWindow;
    try { return nw?.getClipboardText?.() ?? ""; } catch { return ""; }
  }

  private copy(cut: boolean): void {
    if (this.anchor === null) return;
    this.clipboardSet(this.clipboardText());
    if (cut) this.deleteSelection();
  }

  private paste(): void {
    const text = this.clipboardGet();
    if (!text) return;
    this.mutate("paste");
    if (this.anchor !== null) this.deleteSelection(false);
    const lines = text.split("\n");
    if (lines.length === 1) {
      this.insertRaw(lines[0]!);
    } else {
      // First line into current block; rest become new blocks.
      this.insertRaw(lines[0]!);
      const b = this.blockOf(this.caret)!;
      const tail = takeSpansFrom(b, this.caret.offset);
      const baseStyle = b.spans[0]?.style ?? tail[0]?.style ?? {
        family: "inter" as const, weight: 400, italic: false, sizePx: 16, color: this.theme.text,
      };
      const newBlocks: Block[] = lines.slice(1).map((l) => ({
        id: newBlockId(),
        kind: "paragraph" as const,
        spans: l ? [{ text: l, style: { ...baseStyle } }] : [],
      }));
      // Last line gets the tail spans appended.
      const last = newBlocks[newBlocks.length - 1]!;
      last.spans.push(...tail);
      this.doc.blocks.splice(this.caret.block + 1, 0, ...newBlocks);
      this.caret = { block: this.caret.block + newBlocks.length, offset: lines[lines.length - 1]!.length };
    }
    this.inserted();
  }

  // ── Undo/redo ─────────────────────────────────────────────────────────────

  private undo(): void {
    const s = this.history.undo(this.doc.blocks, this.caret, this.anchor);
    if (!s) return;
    this.doc.blocks = s.blocks;
    this.caret = s.caret;
    this.anchor = s.anchor;
    this.slash = null;
    this.toolbar = null;
    this.inserted();
  }

  private redo(): void {
    const s = this.history.redo(this.doc.blocks, this.caret, this.anchor);
    if (!s) return;
    this.doc.blocks = s.blocks;
    this.caret = s.caret;
    this.anchor = s.anchor;
    this.inserted();
  }

  // ── Keys ──────────────────────────────────────────────────────────────────

  private handleKey(e: KeyboardEvent): boolean {
    const k = e.key;
    if (this.slash) {
      if (k === "Escape") { this.slash = null; this.dirty = true; return true; }
      if (k === "ArrowDown") { this.slash.index = (this.slash.index + 1) % this.slash.items.length; this.dirty = true; return true; }
      if (k === "ArrowUp") { this.slash.index = (this.slash.index - 1 + this.slash.items.length) % this.slash.items.length; this.dirty = true; return true; }
      if (k === "Enter" || k === "Tab") { this.applySlash(this.slash.index); return true; }
      if (k === "Backspace") {
        const b = this.blockOf({ block: this.slash.block, offset: 0 });
        if (!b || this.caret.offset <= this.slash.slashOffset) { this.slash = null; }
        this.backspace();
        this.updateSlashQuery();
        return true;
      }
      // Fall through to typing.
    }
    if (e.ctrlKey || e.metaKey) {
      switch ((k ?? "").toLowerCase()) {
        case "a": this.selectAll(); return true;
        case "c": this.copy(false); return true;
        case "x": this.copy(true); return true;
        case "v": this.paste(); return true;
        case "z": if (e.shiftKey) this.redo(); else this.undo(); return true;
        case "y": this.redo(); return true;
        case "b": this.applyFormat("bold"); return true;
        case "i": this.applyFormat("italic"); return true;
        case "u": this.applyFormat("underline"); return true;
        default: return false;
      }
    }
    switch (k) {
      case "Backspace": this.backspace(); return true;
      case "Delete": this.forwardDelete(); return true;
      case "Enter": this.splitBlock(); return true;
      case "Escape": this.slash = null; this.toolbar = null; this.anchor = null; this.dirty = true; return true;
      case "ArrowLeft": this.moveCaret(-1, e.shiftKey); return true;
      case "ArrowRight": this.moveCaret(1, e.shiftKey); return true;
      case "ArrowUp": this.moveLine(-1, e.shiftKey); return true;
      case "ArrowDown": this.moveLine(1, e.shiftKey); return true;
      case "Home": this.moveHome(e.shiftKey); return true;
      case "End": this.moveEnd(e.shiftKey); return true;
      case "Tab": this.mutate("type"); this.insertRaw("  "); this.inserted(); return true;
      default:
        if (k === " ") { this.insertChar(" "); return true; }
        if (k && k.length === 1) {
          // With native text input active, real typing arrives via
          // textinput — keydown chars only serve synthetic events.
          if (!this.textInputActive) this.insertChar(k);
          return true;
        }
        return false;
    }
  }

  private selectAll(): void {
    if (this.doc.blocks.length === 0) return;
    this.anchor = { block: 0, offset: 0 };
    const last = this.doc.blocks.length - 1;
    this.caret = { block: last, offset: blockText(this.doc.blocks[last]!).length };
    this.dirty = true;
  }

  private extendSelection(extend: boolean): void {
    if (extend) {
      if (this.anchor === null) this.anchor = { ...this.caret };
    } else {
      this.anchor = null;
      this.toolbar = null;
    }
  }

  private moveCaret(dir: -1 | 1, shift: boolean): void {
    this.extendSelection(shift);
    const b = this.blockOf(this.caret);
    const len = b ? blockText(b).length : 0;
    let { block, offset } = this.caret;
    offset += dir;
    if (offset < 0 && block > 0) {
      block--;
      offset = blockText(this.doc.blocks[block]!).length;
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

  tick(dt: number): void {
    this.time += dt;
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

    // Selection — under the text.
    if (this.anchor !== null) {
      const rects = this.layouter.selectionRects(this.layout, this.anchor, this.caret);
      for (const r of rects) {
        p.rect(ox + r.x, oy + r.y, Math.max(2, r.w), r.h, t.selection);
      }
    }

    // Inline code-span backgrounds — under the text.
    for (const line of this.layout.lines) {
      const ly = oy + line.y;
      if (ly + line.height < viewTop || ly > viewBot) continue;
      if (this.doc.blocks[line.block]!.kind === "codeblock") continue;
      for (const seg of line.segments) {
        if (!seg.style.code) continue;
        const segW = (seg.run.clusterOffsets[seg.end] ?? 0) - (seg.run.clusterOffsets[seg.start] ?? 0);
        p.roundedRect(ox + seg.x - 4, ly + line.height * 0.1, segW + 8, line.height * 0.8, 5, t.codeBg);
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
        case "number":
          this.drawMarker(line.block, line, ox, oy, p);
          break;
        case "todo":
          this.drawCheckbox(block, line, ox, oy, p, t);
          break;
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
        const color = seg.style.code && block.kind !== "codeblock" ? t.codeText : seg.style.color;
        p.text(imgX, imgY, chunk.w, chunk.h, { region: chunk.region, atlasSize: this.atlas.size }, color);

        const segW = (seg.run.clusterOffsets[seg.end] ?? 0) - (seg.run.clusterOffsets[seg.start] ?? 0);
        if (seg.style.underline) {
          p.rect(penX, oy + line.baseline + 2, segW, 1.5, seg.style.color);
        }
        if (seg.style.strikethrough) {
          p.rect(penX, oy + line.baseline - seg.run.ascent * 0.32, segW, 1.5, seg.style.color);
        }
      }
    }

    // Caret — blink: 0.53s on / 0.47s off.
    if (this.focused && this.blinkT % 1.0 < 0.53) {
      p.roundedRect(ox + this.caretShownX - 1, oy + this.caretShownY, 2, this.caretH, 1, t.caret);
    }

    // Slash menu + format toolbar overlays.
    this.renderSlashMenu(p, ox, oy, t);
    this.renderToolbar(p, t);

    p.render(pass, surfaceW, surfaceH, this.atlas, this.time);
  }

  private drawMarker(blockIdx: number, line: { baseline: number; blockStart: number }, ox: number, oy: number, p: GpuTextPass): void {
    if (line.blockStart !== 0) return; // marker on the block's first line only
    const block = this.doc.blocks[blockIdx]!;
    const label = `${block.num ?? 1}.`;
    const chunk = this.cache.getChunk("inter:400:normal", 16, label);
    if (chunk?.region) {
      p.text(ox - 22 - chunk.w, line.baseline + oy - chunk.baselineInBitmap,
        chunk.w, chunk.h, { region: chunk.region, atlasSize: this.atlas.size }, this.theme.bulletColor);
    }
  }

  private drawCheckbox(block: Block, line: { y: number; height: number; baseline: number; blockStart: number },
    ox: number, oy: number, p: GpuTextPass, t: EditorTheme): void {
    if (line.blockStart !== 0) return;
    const s = 14;
    const x = ox - 24;
    const y = oy + line.baseline - s / 2 - 2;
    // Border ring.
    p.roundedRect(x, y, s, s, 4, block.checked ? t.caret : [t.bulletColor[0], t.bulletColor[1], t.bulletColor[2], 0.55]);
    // Inner fill.
    p.roundedRect(x + 1.5, y + 1.5, s - 3, s - 3, 3,
      block.checked ? t.caret : [0.098, 0.106, 0.118, 1]);
    if (block.checked) {
      const chk = this.cache.getChunk("inter:700:normal", 12, "✓");
      if (chk?.region) {
        p.text(x + (s - chk.w) / 2, y + (s - chk.h) / 2 - 1, chk.w, chk.h,
          { region: chk.region, atlasSize: this.atlas.size }, [1, 1, 1, 1]);
      }
    }
  }

  private renderSlashMenu(p: GpuTextPass, ox: number, oy: number, t: EditorTheme): void {
    if (!this.slash || this.slash.items.length === 0) { this.slash && (this.slash.rect = null); return; }
    const itemH = 30;
    const w = 260;
    const h = this.slash.items.length * itemH + 12;
    // Below the caret; flip above if near the bottom.
    const cx = ox + this.caretShownX;
    const cy = oy + this.caretShownY + this.caretH + 6;
    const x = clamp(cx, this.rect.x + 4, this.rect.x + this.rect.w - w - 4);
    const y = cy + h > this.rect.y + this.rect.h - 4 ? oy + this.caretShownY - h - 6 : cy;
    this.slash.rect = { x, y, w, h };

    p.roundedRect(x, y, w, h, 8, [0.16, 0.17, 0.21, 0.98]);
    p.roundedRect(x, y, w, 1, 0, [0.30, 0.32, 0.40, 0.6]);
    for (let i = 0; i < this.slash.items.length; i++) {
      const item = this.slash.items[i]!;
      const iy = y + 6 + i * itemH;
      if (i === this.slash.index) {
        p.roundedRect(x + 4, iy, w - 8, itemH, 6, [0.30, 0.42, 0.75, 0.35]);
      }
      const label = this.cache.getChunk("inter:500:normal", 14, item.label);
      if (label?.region) {
        p.text(x + 12, iy + 4, label.w, label.h, { region: label.region, atlasSize: this.atlas.size }, t.text);
      }
      const hint = this.cache.getChunk("inter:400:normal", 12, item.hint);
      if (hint?.region) {
        p.text(x + w - hint.w - 12, iy + 9, hint.w, hint.h, { region: hint.region, atlasSize: this.atlas.size }, t.textMuted);
      }
    }
  }

  private renderToolbar(p: GpuTextPass, t: EditorTheme): void {
    if (!this.toolbar || this.anchor === null) { this.toolbar = null; return; }
    const r = this.toolbar.rect;
    p.roundedRect(r.x, r.y, r.w, r.h, 8, [0.16, 0.17, 0.21, 0.98]);
    let x = r.x + 6;
    for (const btn of TOOLBAR_BTNS) {
      const style = btn.id === "bold" ? "inter:700:normal" : btn.id === "italic" ? "inter:400:italic" : "inter:400:normal";
      const label = this.cache.getChunk(style, 13, btn.label);
      if (label?.region) {
        p.text(x + (btn.w - label.w) / 2, r.y + (r.h - label.h) / 2 + 1, label.w, label.h,
          { region: label.region, atlasSize: this.atlas.size }, t.text);
      }
      x += btn.w;
    }
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

// ── Helpers ──────────────────────────────────────────────────────────────────

type SpanLike = Span;

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

function rangeHasStyle(b: Block, start: number, end: number, id: string): boolean {
  let pos = 0;
  let all = true;
  let seen = false;
  for (const sp of b.spans) {
    const s0 = pos;
    const s1 = pos + sp.text.length;
    if (s1 > start && s0 < end) {
      seen = true;
      const has =
        id === "bold" ? sp.style.weight >= 700 :
        id === "italic" ? !!sp.style.italic :
        id === "underline" ? !!sp.style.underline :
        id === "strike" ? !!sp.style.strikethrough :
        !!sp.style.code;
      if (!has) all = false;
    }
    pos = s1;
  }
  return seen && all;
}

function inversePatch(id: string): Partial<TextStyle> {
  switch (id) {
    case "bold": return { weight: 400 };
    case "italic": return { italic: false };
    case "underline": return { underline: false };
    case "strike": return { strikethrough: false };
    default: return { code: false };
  }
}

function inside(x: number, y: number, r: { x: number; y: number; w: number; h: number }): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
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
    syntax: darkSyntax,
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
    syntax: lightSyntax,
  };
}
