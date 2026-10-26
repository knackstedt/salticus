// ============================================================================
// surface.ts — the custom GPU editor surface.
//
// A ScreenUiCompositor drawn underneath the html-ui chrome (order -10):
// owns the run cache/atlas/quad pass, lays out the document, renders
// visible lines + decorations + selection + animated caret + overlays
// (slash menu, format toolbar, scrollbar), and handles pointer/wheel/key
// input.
//
// Coordinates: surface pixels (y-down), same space the input bus reports.
// Document space = surface coords minus origin, plus scroll.
//
// Animations (all toggleable via setAnimationsEnabled): block flash on
// markdown/slash transforms, todo checkbox pop, slash menu + toolbar rise-in,
// scrollbar fade.
// ============================================================================

import type { ScreenUiCompositor, RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import { GpuTextPass, type Rgba } from "../text/gpu-text";
import { TextAtlas } from "../text/atlas";
import { RunCache } from "../text/run-cache";
import { DocLayouter, type DocLayout, type EditorTheme, type LaidLine, type LaidSegment } from "./layout";
import { docCompare, blockText, newBlockId, type Block, type BlockKind, type Doc, type DocPos, type Span, type TextStyle } from "./model";
import { History } from "./history";
import { matchBlockShortcut, matchInlineShortcut, inlineMarkerLen, stripBlockPrefix, styleRange } from "./markdown";
import { darkSyntax, lightSyntax } from "./highlight";
import { wikiLinkAt } from "./links";
import { store } from "../app/store";
import { openPageByTitle } from "../app/actions";
import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger();

const PAD_X = 56;
const PAD_TOP = 28;
/** Height of the fixed page-title header above the scrolling doc. */
const TITLE_H = 44;
/** Breathing room below the last block in the scroll range. */
const PAD_BOTTOM = 48;
const SCROLL_LERP = 14;   // /s — exponential smoothing rate
const CARET_LERP = 22;

// Animation timings (seconds).
const FLASH_DUR = 0.45;     // block highlight after a markdown/slash transform
const CHECK_DUR = 0.28;     // todo checkbox pop
const POP_DUR = 0.13;       // slash menu / toolbar rise-in

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
  /** Surface time when the menu opened (rise-in animation). */
  t0: number;
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
  /** Surface time when the toolbar appeared (pop-in animation). */
  t0: number;
  /** Selection bounds the rect was positioned for — repositioned lazily
   *  when the selection keeps growing (keyboard shift-selection). */
  forA: DocPos;
  forB: DocPos;
}

// ── Context menu / block actions ─────────────────────────────────────────────

type MenuRow = { id: string; label: string; hint?: string; disabled?: boolean } | { sep: true };

interface CtxMenuState {
  rows: MenuRow[];
  index: number;
  /** Screen-space rect — set during render for hit testing. */
  rect: { x: number; y: number; w: number; h: number } | null;
  /** "Turn into" submenu. */
  subOpen: boolean;
  subIndex: number;
  subRect: { x: number; y: number; w: number; h: number } | null;
  /** Doc position where the menu was invoked — target for block ops. */
  pos: DocPos;
  /** Wiki-link target under the cursor when the menu opened on one. */
  linkTarget?: string;
  x: number;
  y: number;
  t0: number;
}

const MENU_W = 216;
const MENU_ROW_H = 26;
const MENU_SEP_H = 9;
const MENU_PAD = 6;
const SUB_W = 204;

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
  /** View routing — the doc editor only renders/claims input for doc pages. */
  private active = true;

  // Interaction state.
  caret: DocPos = { block: 0, offset: 0 };
  anchor: DocPos | null = null;
  private focused = false;
  private scrollY = 0;
  private scrollTarget = 0;
  /** Tracks caret position so scroll-into-view only runs on real moves. */
  private lastCaretKey = "";
  private caretX = 0;
  private caretY = 0;
  private caretH = 20;
  private caretShownX = 0;
  private caretShownY = 0;
  private blinkT = 0;
  private goalX: number | null = null;
  private dragging = false;
  /** Last pointer position while drag-selecting — drives edge auto-scroll. */
  private dragX = 0;
  private dragY = 0;
  /** Scrollbar drag (pointer grabbed the scrollbar lane). */
  private scrollDrag = false;
  /** Last time scroll was active — scrollbar fades in/out around it. */
  private scrollActiveT = -10;
  /** Double/triple click tracking for word/paragraph selection. */
  private clickN = 0;
  private clickT = -1;
  private clickPX = 0;
  private clickPY = 0;
  private dirty = true;
  private time = 0;
  private lastTickMs = 0;
  private textInputActive = false;

  // ── Context menu + block drag ─────────────────────────────────────────────
  private ctxMenu: CtxMenuState | null = null;
  /** Block under the pointer — drives the gutter drag grip (-1 = none). */
  private hoverBlock = -1;
  /** Grip hit rect — set during render, like slash.rect. */
  private gripRect: { x: number; y: number; w: number; h: number } | null = null;
  private gripHot = false;
  /** Active block drag (grip grabbed, moving to a new slot). */
  private blockDrag: { src: number; insert: number; downY: number; moved: boolean } | null = null;

  // ── Animation state (all gated by animationsOn) ──────────────────────────
  private animationsOn = true;
  /** Block highlight after a markdown/slash transform. */
  private flashAnim: { block: string; t0: number } | null = null;
  /** Todo checkbox pop after a toggle. */
  private todoAnim: { block: string; checked: boolean; t0: number } | null = null;

  onChange: (() => void) | null = null;

  private ownsCache: boolean;

  constructor(private ctx: RendererModuleContext, sharedCache?: RunCache) {
    const device = ctx.getDevice();
    this.pass = new GpuTextPass(device, ctx.getFormat());
    this.ownsCache = !sharedCache;
    this.cache = sharedCache ?? new RunCache(new TextAtlas(device, 2048));
    this.atlas = this.cache.atlas;
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

  /** Flat segment dump for MCP debugging: line index, x, face, drawn text. */
  layoutDebug(): { line: number; x: number; face: string; text: string }[] {
    const out: { line: number; x: number; face: string; text: string }[] = [];
    this.layout.lines.forEach((line, li) => {
      line.segments.forEach(seg => {
        out.push({ line: li, x: seg.x, face: seg.faceKey, text: seg.runText.slice(seg.start, seg.end) });
      });
    });
    return out;
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

  /** Toggle all cosmetic animations (typewriter pop, flashes, pop-ins). */
  setAnimationsEnabled(on: boolean): void {
    this.animationsOn = on;
    if (!on) {
      this.flashAnim = null;
      this.todoAnim = null;
    }
  }

  setActive(a: boolean): void {
    if (this.active === a) return;
    this.active = a;
    if (!a) { this.focused = false; this.slash = null; this.toolbar = null; this.ctxMenu = null; this.blockDrag = null; this.hoverBlock = -1; }
  }

  get isActive(): boolean {
    return this.active;
  }

  setRect(r: EditorRect): void {
    if (r.x === this.rect.x && r.y === this.rect.y && r.w === this.rect.w && r.h === this.rect.h) return;
    this.rect = r;
    this.dirty = true;
  }

  setDoc(doc: Doc): void {
    // A doc always has ≥1 block so the caret has somewhere to land.
    this.doc = doc.blocks.length ? doc : { blocks: [{ id: newBlockId(), kind: "paragraph", spans: [] }] };
    this.caret = { block: 0, offset: 0 };
    this.anchor = null;
    this.history.clear();
    this.slash = null;
    this.toolbar = null;
    this.ctxMenu = null;
    this.blockDrag = null;
    this.hoverBlock = -1;
    this.pending = null;
    this.flashAnim = null;
    this.todoAnim = null;
    this.renumberLists();
    // New document opens scrolled to the top.
    this.scrollY = 0;
    this.scrollTarget = 0;
    this.lastCaretKey = "0:0";
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
        if (!text || !this.focused || !this.active) return;
        if (store.getState().paletteOpen) return;
        // winit emits "\r" for Enter — keydown already splits the block, so a
        // textinput that is only newlines would double-split. Drop it.
        if (/^[\r\n]+$/.test(text)) return;
        this.insertText(text);
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
  }

  /** Focus and place the caret at the end of the document — called when a doc
   *  page activates so typing works without needing a click first. */
  focusEnd(): void {
    if (!this.active || this.doc.blocks.length === 0) return;
    this.focused = true;
    const last = this.doc.blocks.length - 1;
    this.caret = { block: last, offset: blockText(this.doc.blocks[last]!).length };
    this.lastCaretKey = `${this.caret.block}:${this.caret.offset}`;
    this.anchor = null;
    this.blinkT = 0;
  }

  // ── Input ────────────────────────────────────────────────────────────────

  private installInput(): void {
    const bus = this.ctx.getInputBus();
    const inRect = (x: number, y: number) =>
      this.active &&
      x >= this.rect.x && x <= this.rect.x + this.rect.w &&
      y >= this.rect.y && y <= this.rect.y + this.rect.h;

    this.unsubs.push(bus.onPointerDown((e, ctrl) => {
      this.scrollDrag = false;
      // Context menu eats its own clicks first.
      if (this.ctxMenu) {
        const m = this.ctxMenu;
        if (m.subOpen && m.subRect && inside(e.clientX, e.clientY, m.subRect)) {
          ctrl.stopPropagation();
          const idx = Math.floor((e.clientY - m.subRect.y - MENU_PAD) / MENU_ROW_H);
          const item = SLASH_ITEMS[idx];
          if (item) this.applyTurnInto(item.kind);
          return;
        }
        if (m.rect && inside(e.clientX, e.clientY, m.rect)) {
          ctrl.stopPropagation();
          const hit = this.menuRowAt(m, e.clientY);
          const row = hit >= 0 ? m.rows[hit]! : null;
          if (row && !("sep" in row) && !row.disabled) {
            if (row.id === "turn") { m.subOpen = true; m.subIndex = 0; m.index = hit; }
            else this.ctxAction(row.id);
          }
          return;
        }
        this.ctxMenu = null; // click outside dismisses (a right-click re-opens below)
      }
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
        if (this.focused) { this.focused = false; this.history.barrier(); }
        this.slash = null;
        return;
      }
      ctrl.stopPropagation();

      // Right click — context menu. A right-click inside the live selection
      // keeps it (standard editor behavior); elsewhere the caret moves.
      if (e.button === 2) {
        this.focused = true;
        this.slash = null;
        this.toolbar = null;
        const pos = this.posAtSurface(e.clientX, e.clientY);
        const sel = this.selRange();
        const insideSel = sel !== null && docCompare(sel[0], pos) <= 0 && docCompare(pos, sel[1]) <= 0;
        if (!insideSel) {
          this.caret = pos;
          this.anchor = null;
        }
        this.dragging = false;
        this.blinkT = 0;
        this.openCtxMenu(e.clientX, e.clientY, pos, "text");
        return;
      }
      if (e.button !== 0) return; // middle/aux buttons don't place a caret

      // Scrollbar lane — right edge of the surface, when content overflows.
      if (this.maxScroll() > 0 && e.clientX >= this.rect.x + this.rect.w - 14) {
        this.scrollDrag = true;
        this.scrollActiveT = this.time;
        this.scrollbarJump(e.clientY);
        return;
      }

      this.focused = true;
      this.slash = null;
      this.toolbar = null;

      // Gutter drag grip — starts a block move instead of a caret click.
      if (this.gripRect && inside(e.clientX, e.clientY, this.gripRect) && this.hoverBlock >= 0) {
        this.blockDrag = { src: this.hoverBlock, insert: this.hoverBlock, downY: e.clientY, moved: false };
        this.dragX = e.clientX;
        this.dragY = e.clientY;
        this.anchor = null;
        return;
      }

      // Todo checkbox hit?
      const pos = this.posAtSurface(e.clientX, e.clientY);
      if (this.tryToggleTodo(e.clientX, e.clientY)) {
        this.dragging = false;
        return;
      }

      // Wiki-link click — follow `[[Title]]` instead of placing a caret.
      // Clicking the bracket-adjacent edge still plants the caret normally.
      const link = this.linkAtPos(pos);
      if (link) {
        this.focused = true;
        this.dragging = false;
        openPageByTitle(link.target);
        return;
      }
      this.dragX = e.clientX;
      this.dragY = e.clientY;

      // Multi-click: double = word, triple+ = whole block.
      const near = Math.abs(e.clientX - this.clickPX) < 8 && Math.abs(e.clientY - this.clickPY) < 8;
      this.clickN = near && this.time - this.clickT < 0.5 ? this.clickN + 1 : 1;
      this.clickT = this.time;
      this.clickPX = e.clientX;
      this.clickPY = e.clientY;
      if (!e.shiftKey && this.clickN >= 2) {
        this.pending = null;
        if (this.clickN === 2) this.selectWordAt(pos);
        else this.selectBlockAt(pos);
        this.dragging = false;
        this.blinkT = 0;
        return;
      }

      this.dragging = true;
      this.pending = null;
      if (e.shiftKey && this.anchor === null) this.anchor = { ...this.caret };
      if (e.shiftKey) {
        this.caret = pos;
      } else {
        this.caret = pos;
        this.anchor = null;
      }
      this.blinkT = 0;
      this.goalX = null;
    }, 50));

    this.unsubs.push(bus.onDrag((_d, ctrl) => {
      if (!this.dragging && !this.scrollDrag) return;
      ctrl.stopPropagation();
    }, 50));

    this.unsubs.push(bus.onPointerMove((e, ctrl) => {
      if (this.blockDrag) {
        ctrl.stopPropagation();
        this.dragX = e.clientX;
        this.dragY = e.clientY;
        const ins = this.blockInsertIndex(this.docY(e.clientY));
        if (ins !== this.blockDrag.insert) this.blockDrag.insert = ins;
        // Past the dead zone the drag is real — a tiny jiggle stays a click.
        if (ins !== this.blockDrag.src || Math.abs(e.clientY - this.blockDrag.downY) > 3) {
          this.blockDrag.moved = true;
        }
        return;
      }
      if (this.scrollDrag) {
        ctrl.stopPropagation();
        this.scrollActiveT = this.time;
        this.scrollbarJump(e.clientY);
        return;
      }
      if (!this.dragging) {
        // Gutter grip + menu hover tracking (block lookup is y-only so the
        // left margin counts toward its block).
        this.hoverBlock = this.blockAtY(e.clientX, e.clientY);
        this.gripHot = this.gripRect !== null && inside(e.clientX, e.clientY, this.gripRect);
        if (this.ctxMenu) this.ctxMenuHover(e.clientX, e.clientY);
        // Slash menu hover highlight.
        if (this.slash?.rect && inside(e.clientX, e.clientY, this.slash.rect)) {
          const idx = Math.floor((e.clientY - this.slash.rect.y - 6) / 30);
          if (idx >= 0 && idx < this.slash.items.length && idx !== this.slash.index) {
            this.slash.index = idx;
          }
        }
        return;
      }
      ctrl.stopPropagation();
      this.dragX = e.clientX;
      this.dragY = e.clientY;
      if (this.anchor === null) this.anchor = { ...this.caret };
      this.caret = this.posAtSurface(e.clientX, e.clientY);
    }, 50));

    this.unsubs.push(bus.onPointerUp((_e, ctrl) => {
      this.scrollDrag = false;
      if (this.blockDrag) {
        ctrl.stopPropagation();
        const bd = this.blockDrag;
        this.blockDrag = null;
        if (bd.moved && bd.insert !== bd.src && bd.insert !== bd.src + 1) {
          this.mutate("move");
          const [blk] = this.doc.blocks.splice(bd.src, 1);
          const ins = bd.insert > bd.src ? bd.insert - 1 : bd.insert;
          this.doc.blocks.splice(ins, 0, blk!);
          this.caret = { block: ins, offset: 0 };
          this.anchor = null;
          if (this.animationsOn) this.flashAnim = { block: blk!.id, t0: this.time };
          this.inserted();
        } else if (!bd.moved) {
          // Plain click on the grip → block action menu (AppFlowy parity).
          const g = this.gripRect;
          this.openCtxMenu(g ? g.x + g.w + 4 : 0, g ? g.y + 4 : 0, { block: bd.src, offset: 0 }, "block");
        }
        return;
      }
      if (this.dragging) ctrl.stopPropagation();
      this.dragging = false;
      // Show the format toolbar whenever a selection settles — after a drag
      // or a double/triple-click word/block selection.
      if (this.anchor !== null && docCompare(this.anchor, this.caret) !== 0) {
        this.showToolbar();
      }
    }, 50));

    this.unsubs.push(bus.onWheel((e, ctrl) => {
      if (!inRect(e.clientX, e.clientY)) return;
      ctrl.stopPropagation();
      this.scrollTarget = clamp(this.scrollTarget + e.deltaY, 0, this.maxScroll());
      this.scrollActiveT = this.time;
      this.toolbar = null;
      this.ctxMenu = null;
    }, 50));

    this.unsubs.push(bus.onKeyDown((e, ctrl) => {
      if (this.blockDrag && e.key === "Escape") {
        this.blockDrag = null;
        ctrl.stopPropagation();
        return;
      }
      if (!this.focused || !this.active) return;
      if (this.handleKey(e)) ctrl.stopPropagation();
    }, 50));
  }

  /** Doc-space y for a surface-space y (accounts for the title header). */
  private docY(sy: number): number {
    return sy - this.rect.y + this.scrollY - PAD_TOP - TITLE_H;
  }

  private posAtSurface(sx: number, sy: number): DocPos {
    if (!this.layout) return { block: 0, offset: 0 };
    const dx = sx - this.rect.x - PAD_X;
    return this.layouter.posAt(this.layout, dx, this.docY(sy));
  }

  private tryToggleTodo(sx: number, sy: number): boolean {
    if (!this.layout) return false;
    const dx = sx - this.rect.x - PAD_X;
    const dy = this.docY(sy);
    if (dx < -26 || dx > -2) return false; // marker column only
    for (const line of this.layout.lines) {
      if (dy < line.y || dy >= line.y + line.height) continue;
      const b = this.doc.blocks[line.block];
      if (b?.kind === "todo" && line.blockFirst) {
        this.history.push(this.doc.blocks, this.caret, this.anchor, "toggle");
        b.checked = !b.checked;
        this.anchor = null;
        if (this.animationsOn) this.todoAnim = { block: b.id, checked: b.checked, t0: this.time };
        this.onChange?.();
        return true;
      }
      return false;
    }
    return false;
  }

  /** Scroll range bottom — content height plus padding, minus viewport. */
  private maxScroll(): number {
    return Math.max(0, (this.layout?.height ?? 0) + PAD_TOP + TITLE_H + PAD_BOTTOM - this.rect.h);
  }

  /** Map a pointer y to a scroll position (scrollbar drag). */
  private scrollbarJump(y: number): void {
    const trackH = this.rect.h - 8;
    const total = (this.layout?.height ?? 0) + PAD_TOP + TITLE_H + PAD_BOTTOM;
    const thumbH = Math.max(28, trackH * (this.rect.h / Math.max(total, 1)));
    const ratio = (y - this.rect.y - 4 - thumbH / 2) / Math.max(1, trackH - thumbH);
    this.scrollTarget = clamp(ratio * this.maxScroll(), 0, this.maxScroll());
  }

  /** Double-click: select the word under the caret position. */
  private selectWordAt(pos: DocPos): void {
    const b = this.blockOf(pos);
    if (!b) return;
    const t = blockText(b);
    const n = t.length;
    // Select the contiguous run of the clicked char's class — word chars,
    // whitespace, or punctuation — without crossing into neighbors.
    const clsOf = (c: string) => (/\w/.test(c) ? 1 : /\s/.test(c) ? 0 : 2);
    const at = n === 0 ? 0 : Math.min(clamp(pos.offset, 0, n), n - 1);
    const cls = clsOf(t[at]!);
    let lo = at, hi = at + 1;
    for (; lo > 0 && clsOf(t[lo - 1]!) === cls; lo--) {}
    for (; hi < n && clsOf(t[hi]!) === cls; hi++) {}
    this.anchor = { block: pos.block, offset: lo };
    this.caret = { block: pos.block, offset: hi };
  }

  /** Triple-click: select the whole block's text. */
  private selectBlockAt(pos: DocPos): void {
    const b = this.blockOf(pos);
    if (!b) return;
    this.anchor = { block: pos.block, offset: 0 };
    this.caret = { block: pos.block, offset: blockText(b).length };
  }

  // ── Context menu + block drag ────────────────────────────────────────────

  /** Normalized [lo, hi] selection, or null when collapsed/no selection. */
  private selRange(): [DocPos, DocPos] | null {
    if (this.anchor === null || docCompare(this.anchor, this.caret) === 0) return null;
    return docCompare(this.anchor, this.caret) <= 0
      ? [this.anchor, this.caret] : [this.caret, this.anchor];
  }

  /** Block index under a surface-space point (vertical only — the gutter
   *  margin counts toward its block). -1 outside the doc column. */
  private blockAtY(sx: number, sy: number): number {
    if (!this.layout || !this.active) return -1;
    if (sx < this.rect.x || sx > this.rect.x + this.rect.w ||
      sy < this.rect.y || sy > this.rect.y + this.rect.h) return -1;
    const dy = this.docY(sy);
    if (dy < 0) return -1;
    const lbs = this.layout.blocks;
    for (let i = 0; i < lbs.length; i++) {
      const lb = lbs[i]!;
      if (dy < lb.y + lb.height) return lb.block;
    }
    return lbs.length ? lbs[lbs.length - 1]!.block : -1;
  }

  /** Insertion slot for a block drop at doc-space y — the index the dragged
   *  block would occupy (0..blocks.length). */
  private blockInsertIndex(dy: number): number {
    const lbs = this.layout?.blocks ?? [];
    for (let i = 0; i < lbs.length; i++) {
      const lb = lbs[i]!;
      if (dy < lb.y + lb.height / 2) return i;
    }
    return lbs.length;
  }

  /** Doc-space y of the boundary where an insert at `idx` would land —
   *  the midpoint of the gap between the neighboring blocks. */
  private insertLineY(idx: number): number {
    const lbs = this.layout?.blocks ?? [];
    if (lbs.length === 0) return 0;
    if (idx <= 0) return lbs[0]!.y - 5;
    if (idx >= lbs.length) return lbs[lbs.length - 1]!.y + lbs[lbs.length - 1]!.height + 5;
    const prev = lbs[idx - 1]!;
    return (prev.y + prev.height + lbs[idx]!.y) / 2;
  }

  /** Wiki-link under a doc position, if any (never inside codeblocks). */
  private linkAtPos(pos: DocPos): { target: string } | null {
    const b = this.doc.blocks[pos.block];
    if (!b || b.kind === "codeblock") return null;
    return wikiLinkAt(blockText(b), pos.offset);
  }

  private openCtxMenu(x: number, y: number, pos: DocPos, mode: "text" | "block"): void {
    const hasSel = this.selRange() !== null;
    const link = mode === "text" ? this.linkAtPos(pos) : null;
    const rows: MenuRow[] = mode === "text" ? [
      ...(link ? [
        { id: "openLink", label: "Open link", hint: link.target } satisfies MenuRow,
        { sep: true } satisfies MenuRow,
      ] : []),
      { id: "cut", label: "Cut", hint: "Ctrl+X", disabled: !hasSel },
      { id: "copy", label: "Copy", hint: "Ctrl+C", disabled: !hasSel },
      { id: "paste", label: "Paste", hint: "Ctrl+V" },
      { sep: true },
      { id: "turn", label: "Turn into", hint: "›" },
      { sep: true },
      { id: "duplicate", label: "Duplicate" },
      { id: "delete", label: "Delete" },
    ] : [
      { id: "turn", label: "Turn into", hint: "›" },
      { sep: true },
      { id: "insertBelow", label: "Insert below" },
      { id: "duplicate", label: "Duplicate" },
      { id: "moveUp", label: "Move up", hint: "Ctrl+⇧↑", disabled: pos.block === 0 },
      { id: "moveDown", label: "Move down", hint: "Ctrl+⇧↓", disabled: pos.block >= this.doc.blocks.length - 1 },
      { sep: true },
      { id: "delete", label: "Delete" },
    ];
    // Initial highlight lands on the first actionable row.
    let index = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (!("sep" in r) && !r.disabled) { index = i; break; }
    }
    this.ctxMenu = { rows, index, rect: null, subOpen: false, subIndex: 0, subRect: null, pos, linkTarget: link?.target, x, y, t0: this.time };
    this.slash = null;
    this.toolbar = null;
  }

  private menuRowTop(m: CtxMenuState, i: number): number {
    let y = (m.rect?.y ?? m.y) + MENU_PAD;
    for (let k = 0; k < i; k++) y += "sep" in m.rows[k]! ? MENU_SEP_H : MENU_ROW_H;
    return y;
  }

  private menuRowAt(m: CtxMenuState, py: number): number {
    if (!m.rect) return -1;
    let y = m.rect.y + MENU_PAD;
    for (let i = 0; i < m.rows.length; i++) {
      const h = "sep" in m.rows[i]! ? MENU_SEP_H : MENU_ROW_H;
      if (py >= y && py < y + h) return i;
      y += h;
    }
    return -1;
  }

  private ctxMenuHover(x: number, y: number): void {
    const m = this.ctxMenu;
    if (!m) return;
    if (m.subOpen && m.subRect && inside(x, y, m.subRect)) {
      const idx = Math.floor((y - m.subRect.y - MENU_PAD) / MENU_ROW_H);
      if (idx >= 0 && idx < SLASH_ITEMS.length) m.subIndex = idx;
      return;
    }
    if (m.rect && inside(x, y, m.rect)) {
      const hit = this.menuRowAt(m, y);
      if (hit < 0) return;
      m.index = hit;
      const row = m.rows[hit]!;
      // Hovering the "Turn into" row opens its submenu; anything else closes it.
      m.subOpen = !("sep" in row) && row.id === "turn";
    }
  }

  private ctxAction(id: string): void {
    const m = this.ctxMenu;
    this.ctxMenu = null;
    if (!m) return;
    const target = clamp(m.pos.block, 0, Math.max(0, this.doc.blocks.length - 1));
    switch (id) {
      case "openLink": if (m.linkTarget) openPageByTitle(m.linkTarget); return;
      case "cut": this.copy(true); return;
      case "copy": this.copy(false); return;
      case "paste": this.paste(); return;
      case "delete": {
        if (this.selRange()) { this.deleteSelection(); return; }
        this.mutate("delete");
        if (this.doc.blocks.length <= 1) {
          // Last block — clear it rather than leaving an empty document.
          const b = this.doc.blocks[0];
          if (b) { b.kind = "paragraph"; b.spans = []; delete b.lang; delete b.checked; delete b.num; }
          this.caret = { block: 0, offset: 0 };
        } else {
          this.doc.blocks.splice(target, 1);
          this.caret = { block: Math.min(target, this.doc.blocks.length - 1), offset: 0 };
        }
        this.anchor = null;
        this.inserted();
        return;
      }
      case "duplicate": {
        const b = this.doc.blocks[target];
        if (!b) return;
        this.mutate("duplicate");
        const clone: Block = {
          id: newBlockId(), kind: b.kind,
          spans: b.spans.map(s => ({ text: s.text, style: { ...s.style } })),
          lang: b.lang, checked: b.checked, num: b.num,
        };
        this.doc.blocks.splice(target + 1, 0, clone);
        this.caret = { block: target + 1, offset: this.caret.block === target ? this.caret.offset : 0 };
        this.anchor = null;
        this.inserted();
        return;
      }
      case "insertBelow": {
        this.mutate("insert");
        this.doc.blocks.splice(target + 1, 0, { id: newBlockId(), kind: "paragraph", spans: [] });
        this.caret = { block: target + 1, offset: 0 };
        this.anchor = null;
        this.inserted();
        return;
      }
      case "moveUp": case "moveDown": {
        this.caret = { block: target, offset: 0 };
        this.anchor = null;
        this.moveBlock(id === "moveUp" ? -1 : 1);
        return;
      }
    }
  }

  /** Apply a block kind ("Turn into") — to the selection's span of blocks
   *  when one exists, else the block the menu was invoked on. */
  private applyTurnInto(kind: BlockKind): void {
    const m = this.ctxMenu;
    this.ctxMenu = null;
    const sel = this.selRange();
    const a = sel ? sel[0].block : clamp(m?.pos.block ?? 0, 0, Math.max(0, this.doc.blocks.length - 1));
    const b = sel ? sel[1].block : a;
    this.mutate("format");
    for (let i = a; i <= b; i++) {
      const blk = this.doc.blocks[i];
      if (!blk) continue;
      blk.kind = kind;
      if (kind === "todo") blk.checked = false;
      if (kind === "number") blk.num = 1;
      if (kind === "codeblock" && !blk.lang) blk.lang = "ts";
      if (kind === "divider") blk.spans = [];
      if (this.animationsOn) this.flashAnim = { block: blk.id, t0: this.time };
    }
    this.anchor = null;
    const cb = this.blockOf(this.caret);
    if (cb) this.caret = { ...this.caret, offset: Math.min(this.caret.offset, blockText(cb).length) };
    this.inserted();
  }

  /** Move the caret's block one slot (Ctrl+Shift+Arrow / menu). */
  private moveBlock(dir: -1 | 1): void {
    const i = this.caret.block;
    const j = i + dir;
    if (i < 0 || i >= this.doc.blocks.length || j < 0 || j >= this.doc.blocks.length) return;
    this.mutate("move");
    const [blk] = this.doc.blocks.splice(i, 1);
    this.doc.blocks.splice(j, 0, blk!);
    this.caret = { ...this.caret, block: j };
    this.anchor = null;
    this.inserted();
  }

  // ── Editing ─────────────────────────────────────────────────────────────

  private blockOf(pos: DocPos): Block | undefined {
    return this.doc.blocks[clamp(pos.block, 0, Math.max(0, this.doc.blocks.length - 1))];
  }

  private mutate(kind: string): void {
    this.history.push(this.doc.blocks, this.caret, this.anchor, kind);
  }

  private inserted(): void {
    this.renumberLists();
    this.dirty = true;
    this.blinkT = 0;
    this.onChange?.();
  }

  /** Keep contiguous `number` runs sequential — items after an
   *  insert/delete/split pick up their predecessor's number + 1. */
  private renumberLists(): void {
    let prev: Block | null = null;
    this.doc.blocks.forEach(b => {
      if (b.kind === "number") {
        b.num = prev?.kind === "number" ? (prev.num ?? 0) + 1 : 1;
      }
      prev = b;
    });
  }

  private insertText(text: string): void {
    // Normalize CR-style line breaks (IME commits, winit textinput) and drop
    // other control chars that would rasterize as tofu. Includes the C1 range
    // (U+0080–U+009F) — never printable, always a paste/encoding accident.
    // oxlint-disable-next-line no-control-regex — intentional: strips control chars
    const clean = text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
    for (let ti = 0; ti < clean.length; ti++) {
      this.insertChar(clean[ti]!);
    }
  }

  private insertChar(ch: string): void {
    // Dividers can't hold text — spill into a fresh paragraph below.
    const db = this.blockOf(this.caret);
    if (db?.kind === "divider") {
      this.mutate("type");
      this.doc.blocks.splice(this.caret.block + 1, 0, { id: newBlockId(), kind: "paragraph", spans: [] });
      this.caret = { block: this.caret.block + 1, offset: 0 };
      if (ch === "\n") { this.inserted(); return; }
      // Fall through — `ch` is processed in the new paragraph.
    }

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
          if (this.animationsOn) this.flashAnim = { block: b.id, t0: this.time };
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

  /** Raw text insert at caret (no markdown/slash handling). */
  private insertRaw(text: string, styled = true): void {
    if (this.doc.blocks.length === 0) {
      this.doc.blocks.push({ id: newBlockId(), kind: "paragraph", spans: [] });
      this.caret = { block: 0, offset: 0 };
    }
    if (this.anchor !== null) this.deleteSelection(false);
    const b = this.blockOf(this.caret);
    if (!b) return;
    const applyPending = (start: number) => {
      const ps = styled ? this.pendingStyle() : null;
      if (ps) styleRange(b, start, start + text.length, ps);
    };
    if (b.spans.length === 0) {
      b.spans.push({ text, style: { family: "inter", weight: 400, italic: false, sizePx: 16 } });
      applyPending(0);
      this.caret = { block: this.caret.block, offset: text.length };
      return;
    }
    let off = 0;
    for (let i = 0; i < b.spans.length; i++) {
      const sp = b.spans[i]!;
      if (this.caret.offset <= off + sp.text.length || i === b.spans.length - 1) {
        const inner = clamp(this.caret.offset - off, 0, sp.text.length);
        sp.text = sp.text.slice(0, inner) + text + sp.text.slice(inner);
        applyPending(off + inner);
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
      const t = blockText(b!);
      // Delete the whole codepoint — surrogate pairs go together.
      const n = this.caret.offset >= 2 && isLowSurrogate(t.charCodeAt(this.caret.offset - 1)) && isHighSurrogate(t.charCodeAt(this.caret.offset - 2)) ? 2 : 1;
      spliceSpans(b!, this.caret.offset - n, n);
      this.caret = { ...this.caret, offset: this.caret.offset - n };
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
      if (b?.kind === "divider") {
        // Backspace on the first block being a divider deletes it outright —
        // no previous block to merge into.
        this.doc.blocks.splice(this.caret.block, 1);
      } else if (b && b.kind !== "paragraph") {
        b.kind = "paragraph"; // backspace at start unstyles the block
      }
    }
    this.inserted();
  }

  /** Word-boundary scan helpers — skip whitespace, then same-class chars. */
  private wordBack(pos: DocPos): DocPos {
    let { block, offset } = pos;
    while (block >= 0) {
      const t = blockText(this.doc.blocks[block]!);
      let i = offset;
      while (i > 0 && /\s/.test(t[i - 1]!)) i--;
      const cls = (c: string) => /\w/.test(c);
      if (i > 0) { const c = cls(t[i - 1]!); while (i > 0 && !/\s/.test(t[i - 1]!) && cls(t[i - 1]!) === c) i--; }
      if (i !== offset || block === 0) return { block, offset: i };
      block--; offset = blockText(this.doc.blocks[block]!).length;
    }
    return { block: 0, offset: 0 };
  }

  private wordForward(pos: DocPos): DocPos {
    let { block, offset } = pos;
    while (block < this.doc.blocks.length) {
      const t = blockText(this.doc.blocks[block]!);
      let i = offset;
      const cls = (c: string) => /\w/.test(c);
      if (i < t.length) { const c = cls(t[i]!); while (i < t.length && !/\s/.test(t[i]!) && cls(t[i]!) === c) i++; }
      while (i < t.length && /\s/.test(t[i]!)) i++;
      if (i !== offset || block === this.doc.blocks.length - 1) return { block, offset: i };
      block++; offset = 0;
    }
    const last = this.doc.blocks.length - 1;
    return { block: last, offset: blockText(this.doc.blocks[last]!).length };
  }

  private moveWord(dir: -1 | 1, shift: boolean): void {
    this.extendSelection(shift);
    this.caret = dir < 0 ? this.wordBack(this.caret) : this.wordForward(this.caret);
    this.goalX = null;
    this.blinkT = 0;
  }

  private backspaceWord(): void {
    if (this.anchor !== null) { this.deleteSelection(); return; }
    const start = this.wordBack(this.caret);
    if (start.block !== this.caret.block) { this.backspace(); return; }
    this.mutate("delete");
    spliceSpans(this.blockOf(this.caret)!, start.offset, this.caret.offset - start.offset);
    this.caret = start;
    this.inserted();
  }

  private deleteWordForward(): void {
    if (this.anchor !== null) { this.deleteSelection(); return; }
    const end = this.wordForward(this.caret);
    if (end.block !== this.caret.block) { this.forwardDelete(); return; }
    this.mutate("delete");
    spliceSpans(this.blockOf(this.caret)!, this.caret.offset, end.offset - this.caret.offset);
    this.inserted();
  }

  private forwardDelete(): void {
    if (this.anchor !== null) { this.deleteSelection(); return; }
    this.mutate("delete");
    const b = this.blockOf(this.caret);
    const len = b ? blockText(b).length : 0;
    if (this.caret.offset < len) {
      const t = blockText(b!);
      const n = this.caret.offset + 1 < len && isHighSurrogate(t.charCodeAt(this.caret.offset)) && isLowSurrogate(t.charCodeAt(this.caret.offset + 1)) ? 2 : 1;
      spliceSpans(b!, this.caret.offset, n);
    } else if (this.caret.block + 1 < this.doc.blocks.length) {
      const next = this.doc.blocks.splice(this.caret.block + 1, 1)[0]!;
      b!.spans.push(...next.spans);
    }
    this.inserted();
  }

  private splitBlock(): void {
    // Snapshot BEFORE deleting the selection — otherwise undo restores the
    // post-delete state and the selected text is unrecoverable.
    this.mutate("split");
    if (this.anchor !== null) this.deleteSelection(false);
    const b = this.blockOf(this.caret);
    if (!b) return;
    // In codeblocks, Enter inserts a newline INSIDE the block — unless the
    // caret sits on a trailing empty line, where Enter exits the block into
    // a fresh paragraph (double-Enter-to-exit, Notion-style).
    if (b.kind === "codeblock") {
      const text = blockText(b);
      if (this.caret.offset === text.length && text.endsWith("\n")) {
        spliceSpans(b, text.length - 1, 1);
        this.doc.blocks.splice(this.caret.block + 1, 0, { id: newBlockId(), kind: "paragraph", spans: [] });
        this.caret = { block: this.caret.block + 1, offset: 0 };
      } else {
        this.insertRaw("\n");
      }
      this.inserted();
      return;
    }
    // Enter on a divider inserts a paragraph below — the rule survives.
    if (b.kind === "divider") {
      this.doc.blocks.splice(this.caret.block + 1, 0, { id: newBlockId(), kind: "paragraph", spans: [] });
      this.caret = { block: this.caret.block + 1, offset: 0 };
      this.inserted();
      return;
    }
    // Enter on an empty non-paragraph block converts it to a paragraph
    // (exits lists/headings/quotes — Notion behavior).
    if (blockText(b).length === 0 && b.kind !== "paragraph") {
      b.kind = "paragraph";
      this.caret = { block: this.caret.block, offset: 0 };
      this.inserted();
      return;
    }
    const tail = takeSpansFrom(b, this.caret.offset);
    let kind = b.kind;
    if (kind === "h1" || kind === "h2" || kind === "h3" || kind === "quote" || kind === "callout") {
      kind = "paragraph";
    }
    const nb: Block = { id: newBlockId(), kind, spans: tail };
    if (kind === "todo") nb.checked = false;
    if (kind === "number") nb.num = (b.num ?? 1) + 1;
    this.doc.blocks.splice(this.caret.block + 1, 0, nb);
    this.caret = { block: this.caret.block + 1, offset: 0 };
    this.inserted();
  }

  // ── Slash menu ────────────────────────────────────────────────────────────

  private openSlash(block: number, slashOffset: number): void {
    this.slash = { block, slashOffset, index: 0, items: SLASH_ITEMS, rect: null, t0: this.time };
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
    if (this.animationsOn) this.flashAnim = { block: b.id, t0: this.time };
    this.inserted();
  }

  // ── Format toolbar ────────────────────────────────────────────────────────

  private showToolbar(): void {
    if (!this.layout || this.anchor === null) return;
    const [a, b] = docCompare(this.anchor, this.caret) <= 0
      ? [this.anchor, this.caret] : [this.caret, this.anchor];
    const rects = this.layouter.selectionRects(this.layout, a, b);
    if (rects.length === 0) return;
    const top = rects[0]!;
    const w = TOOLBAR_BTNS.reduce((n, b) => n + b.w, 0) + 12;
    const x = clamp(this.rect.x + PAD_X + top.x, this.rect.x + 4, this.rect.x + this.rect.w - w - 4);
    const y = Math.max(this.rect.y + 4, this.rect.y + PAD_TOP + TITLE_H - this.scrollY + top.y - 38);
    const prev = this.toolbar;
    this.toolbar = {
      rect: { x, y, w, h: 32 },
      t0: prev?.t0 ?? this.time,
      forA: { ...a }, forB: { ...b },
    };
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

  /** Format toggles armed with no selection — applied to subsequently typed
   *  text (standard Ctrl+B-then-type behavior). */
  private pending: Partial<Record<string, boolean>> | null = null;

  private pendingStyle(): Partial<TextStyle> | null {
    if (!this.pending) return null;
    const st: Partial<TextStyle> = {};
    Object.keys(this.pending).forEach((id) => {
      const f = FORMAT[id];
      if (f) Object.assign(st, this.pending![id] ? f.on : f.off);
    });
    return Object.keys(st).length ? st : null;
  }

  /** The style freshly typed text would inherit at `offset` — mirrors the
   *  span pick in insertRaw (first span whose end reaches the caret). */
  private typingStyle(b: Block, offset: number): TextStyle | null {
    let off = 0;
    for (let i = 0; i < b.spans.length; i++) {
      const sp = b.spans[i]!;
      if (offset <= off + sp.text.length || i === b.spans.length - 1) return sp.style;
      off += sp.text.length;
    }
    return null;
  }

  private applyFormat(id: string): void {
    const f = FORMAT[id];
    if (!f) return;
    const collapsed = this.anchor === null ||
      (this.anchor.block === this.caret.block && this.anchor.offset === this.caret.offset);
    if (collapsed) {
      // No selection — arm/disarm the typing style. The toggle is relative to
      // what the caret would inherit, so Ctrl+B inside a bold span means
      // "type plain from here" rather than re-arming bold forever.
      const b = this.blockOf(this.caret);
      const st = b ? this.typingStyle(b, this.caret.offset) : null;
      const inherited = st ? f.has(st) : false;
      const next = !(this.pending?.[id] ?? inherited);
      const p = { ...this.pending };
      if (next === inherited) delete p[id]; else p[id] = next;
      this.pending = Object.keys(p).length ? p : null;
      this.anchor = null;
      this.blinkT = 0;
      return;
    }
    this.mutate("format");
    const a = docCompare(this.anchor, this.caret) <= 0 ? this.anchor : this.caret;
    const b = docCompare(this.anchor, this.caret) <= 0 ? this.caret : this.anchor;
    // One decision for the whole selection — per-block toggling produced
    // inside-out results when blocks disagreed (one bold, one plain).
    let all = true, seen = false;
    for (let bi = a.block; bi <= b.block; bi++) {
      const blk = this.doc.blocks[bi]!;
      const s = bi === a.block ? a.offset : 0;
      const e = bi === b.block ? b.offset : blockText(blk).length;
      if (e > s) { seen = true; if (!rangeHasStyle(blk, s, e, id)) all = false; }
    }
    const patch = seen && all ? f.off : f.on;
    for (let bi = a.block; bi <= b.block; bi++) {
      const blk = this.doc.blocks[bi]!;
      const s = bi === a.block ? a.offset : 0;
      const e = bi === b.block ? b.offset : blockText(blk).length;
      if (e > s) styleRange(blk, s, e, patch);
    }
    this.inserted();
  }

  /** Ctrl+\ — strip every inline mark from the selection (Notion). With a
   *  collapsed caret it just disarms pending typing styles. */
  private clearFormat(): void {
    if (this.anchor === null) { this.pending = null; return; }
    const patch: Partial<TextStyle> =
      { weight: 400, italic: false, underline: false, strikethrough: false, code: false };
    this.mutate("format");
    const a = docCompare(this.anchor, this.caret) <= 0 ? this.anchor : this.caret;
    const b = docCompare(this.anchor, this.caret) <= 0 ? this.caret : this.anchor;
    for (let bi = a.block; bi <= b.block; bi++) {
      const blk = this.doc.blocks[bi]!;
      const s = bi === a.block ? a.offset : 0;
      const e = bi === b.block ? b.offset : blockText(blk).length;
      if (e > s) styleRange(blk, s, e, patch);
    }
    this.inserted();
  }

  // ── Clipboard ─────────────────────────────────────────────────────────────

  /** Internal structured copy — lets paste restore block kinds + spans when
   *  the OS clipboard still holds the text we exported. */
  private internalClip: { text: string; blocks: Block[] } | null = null;

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

  /** Deep-copy of the selected block range — first/last blocks sliced at the
   *  anchor/caret offsets, middle blocks whole. */
  private sliceSelection(): Block[] {
    const a = docCompare(this.anchor!, this.caret) <= 0 ? this.anchor! : this.caret;
    const b = docCompare(this.anchor!, this.caret) <= 0 ? this.caret : this.anchor!;
    const out: Block[] = [];
    for (let bi = a.block; bi <= b.block; bi++) {
      const src = this.doc.blocks[bi]!;
      const s = bi === a.block ? a.offset : 0;
      const e = bi === b.block ? b.offset : blockText(src).length;
      const tmp = { spans: src.spans.map(sp => ({ text: sp.text, style: { ...sp.style } })) };
      spliceSpans(tmp, e, Infinity);
      spliceSpans(tmp, 0, s);
      out.push({ id: newBlockId(), kind: src.kind, spans: tmp.spans, lang: src.lang, checked: src.checked, num: src.num });
    }
    return out;
  }

  /** Splice styled spans into a block at a text offset. */
  private insertSpansAt(b: Block, off: number, spans: Span[]): void {
    const tail = takeSpansFrom(b, off);
    b.spans.push(...spans, ...tail);
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
    const text = this.clipboardText();
    this.clipboardSet(text);
    this.internalClip = { text, blocks: this.sliceSelection() };
    if (cut) this.deleteSelection();
  }

  private paste(plain = false): void {
    // oxlint-disable-next-line no-control-regex — intentional: strips control chars
    const text = this.clipboardGet().replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
    if (!text) return;
    this.pending = null;
    this.mutate("paste");
    if (this.anchor !== null) this.deleteSelection(false);
    const cur = this.blockOf(this.caret);

    // In a codeblock, pasted newlines stay inside the block.
    if (cur?.kind === "codeblock") {
      this.insertRaw(text, false);
      this.inserted();
      return;
    }

    if (!plain) {
      // Internal clipboard: the OS text still matches what we copied → restore
      // the full structure (block kinds + inline styles) instead of plaintext.
      const clip = this.internalClip;
      if (clip && clip.blocks.length > 0 && clip.text === text) {
        this.pasteStructured(clip.blocks);
        return;
      }

      // Markdown-looking paste (first line carries a block marker) → typed
      // blocks. Otherwise plain paragraph paste.
      const md = parseMarkdownLines(text);
      if (md) {
        this.pasteBlocks(md);
        return;
      }
    }

    const lines = text.split("\n");
    if (lines.length === 1) {
      this.insertRaw(lines[0]!, false);
    } else {
      // First line into current block; rest become new blocks.
      this.insertRaw(lines[0]!, false);
      const b = this.blockOf(this.caret)!;
      const tail = takeSpansFrom(b, this.caret.offset);
      const baseStyle = b.spans[0]?.style ?? tail[0]?.style ?? {
        family: "inter" as const, weight: 400, italic: false, sizePx: 16,
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

  /** Paste structured blocks from the internal clipboard: first block merges
   *  into the caret block (adopting its kind if the caret block is empty),
   *  the rest splice in below with kinds/spans intact; the caret's old tail
   *  follows the last pasted block. */
  private pasteStructured(blocks: Block[]): void {
    const b = this.blockOf(this.caret);
    if (!b) return;
    const cloneSpans = (ss: Span[]): Span[] => ss.map(s => ({ text: s.text, style: { ...s.style } }));
    const first = blocks[0]!;
    const firstLen = blockText(first).length;
    if (first.kind !== "paragraph" && blockText(b).length === 0) {
      b.kind = first.kind;
      b.checked = first.checked;
      b.num = first.num;
      b.lang = first.lang;
      b.spans = cloneSpans(first.spans);
      this.caret = { block: this.caret.block, offset: firstLen };
    } else {
      this.insertSpansAt(b, this.caret.offset, cloneSpans(first.spans));
      this.caret = { block: this.caret.block, offset: this.caret.offset + firstLen };
    }

    if (blocks.length > 1) {
      const tail = takeSpansFrom(b, this.caret.offset);
      const mid: Block[] = blocks.slice(1).map(src => ({
        id: newBlockId(), kind: src.kind, spans: cloneSpans(src.spans),
        lang: src.lang, checked: src.checked, num: src.num,
      }));
      const last = mid[mid.length - 1]!;
      const endOff = blockText(last).length;
      last.spans.push(...tail);
      this.doc.blocks.splice(this.caret.block + 1, 0, ...mid);
      this.caret = { block: this.caret.block + mid.length, offset: endOff };
    }
    this.inserted();
  }

  /** Paste pre-parsed block items: the first item merges into the current
   *  block (adopting its kind when the current block is an empty paragraph);
   *  the rest are spliced in below, with the caret's tail on the last one. */
  private pasteBlocks(items: ParsedBlock[]): void {
    const b = this.blockOf(this.caret);
    if (!b) return;
    const tail = takeSpansFrom(b, this.caret.offset);
    const baseStyle: TextStyle = b.spans[0]?.style ?? tail[0]?.style ?? {
      family: "inter", weight: 400, italic: false, sizePx: 16,
    };
    const spanOf = (text: string): Span[] =>
      text ? [{ text, style: { ...baseStyle, code: undefined, underline: undefined, strikethrough: undefined } }] : [];

    const first = items[0]!;
    if (first.kind !== "paragraph" && blockText(b).length === 0) {
      // Current block is empty — it becomes the pasted block's kind.
      b.kind = first.kind;
      b.checked = first.checked;
      b.num = first.num;
      b.lang = first.lang;
      b.spans = spanOf(first.text);
      this.caret = { block: this.caret.block, offset: first.text.length };
    } else {
      // Merge its text into the current block at the caret.
      const ins: Span[] = spanOf(first.text);
      let off = 0;
      let done = false;
      for (let i = 0; i < b.spans.length && !done; i++) {
        const sp = b.spans[i]!;
        if (this.caret.offset <= off + sp.text.length || i === b.spans.length - 1) {
          const inner = clamp(this.caret.offset - off, 0, sp.text.length);
          const head = { text: sp.text.slice(0, inner), style: sp.style };
          const rest = { text: sp.text.slice(inner), style: sp.style };
          b.spans.splice(i, 1, ...(head.text ? [head] : []), ...ins, ...(rest.text ? [rest] : []));
          done = true;
        }
        off += sp.text.length;
      }
      if (!done) b.spans.push(...ins);
      this.caret = { block: this.caret.block, offset: this.caret.offset + first.text.length };
    }

    if (items.length > 1) {
      const newBlocks: Block[] = items.slice(1).map((it) => ({
        id: newBlockId(),
        kind: it.kind,
        checked: it.checked,
        num: it.num,
        lang: it.lang,
        spans: spanOf(it.text),
      }));
      const last = newBlocks[newBlocks.length - 1]!;
      last.spans.push(...tail);
      this.doc.blocks.splice(this.caret.block + 1, 0, ...newBlocks);
      this.caret = {
        block: this.caret.block + newBlocks.length,
        offset: items[items.length - 1]!.text.length,
      };
    } else {
      b.spans.push(...tail);
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
    this.pending = null;
    this.inserted();
  }

  private redo(): void {
    const s = this.history.redo(this.doc.blocks, this.caret, this.anchor);
    if (!s) return;
    this.doc.blocks = s.blocks;
    this.caret = s.caret;
    this.anchor = s.anchor;
    this.pending = null;
    this.inserted();
  }

  // ── Keys ──────────────────────────────────────────────────────────────────

  private handleKey(e: KeyboardEvent): boolean {
    const k = e.key;
    if (this.ctxMenu) {
      const m = this.ctxMenu;
      if (k === "Escape") { this.ctxMenu = null; return true; }
      if (m.subOpen) {
        if (k === "ArrowDown") { m.subIndex = (m.subIndex + 1) % SLASH_ITEMS.length; return true; }
        if (k === "ArrowUp") { m.subIndex = (m.subIndex - 1 + SLASH_ITEMS.length) % SLASH_ITEMS.length; return true; }
        if (k === "ArrowLeft") { m.subOpen = false; return true; }
        if (k === "Enter" || k === "Tab") { this.applyTurnInto(SLASH_ITEMS[m.subIndex]!.kind); return true; }
        return true;
      }
      if (k === "ArrowDown" || k === "ArrowUp") {
        const dir = k === "ArrowDown" ? 1 : -1;
        for (let n = 1; n <= m.rows.length; n++) {
          const i = (m.index + dir * n + m.rows.length) % m.rows.length;
          const r = m.rows[i]!;
          if (!("sep" in r) && !r.disabled) { m.index = i; break; }
        }
        return true;
      }
      if (k === "ArrowRight" || k === "Enter" || k === "Tab") {
        const row = m.rows[m.index];
        if (row && !("sep" in row) && !row.disabled) {
          if (row.id === "turn") { m.subOpen = true; m.subIndex = 0; }
          else if (k !== "ArrowRight") this.ctxAction(row.id);
        }
        return true;
      }
      return true; // swallow everything else while the menu is up
    }
    if (this.slash) {
      if (k === "Escape") { this.slash = null; return true; }
      if (k === "ArrowDown") { this.slash.index = (this.slash.index + 1) % this.slash.items.length; return true; }
      if (k === "ArrowUp") { this.slash.index = (this.slash.index - 1 + this.slash.items.length) % this.slash.items.length; return true; }
      if (k === "Enter" || k === "Tab") { this.applySlash(this.slash.index); return true; }
      if (k === "Backspace") {
        const b = this.blockOf({ block: this.slash.block, offset: 0 });
        if (!b || this.caret.offset <= this.slash.slashOffset) { this.slash = null; }
        this.backspace();
        this.updateSlashQuery();
        return true;
      }
      // Caret navigation dismisses the menu — the query would go stale.
      if (k === "ArrowLeft" || k === "ArrowRight" || k === "Home" || k === "End" ||
        k === "PageUp" || k === "PageDown") {
        this.slash = null;
      }
      // Fall through to typing.
    }
    if (e.ctrlKey || e.metaKey) {
      // Word-level nav/edit first — these keys aren't letters.
      if (k === "Backspace") { this.backspaceWord(); return true; }
      if (k === "Delete") { this.deleteWordForward(); return true; }
      if (k === "ArrowLeft") { this.moveWord(-1, e.shiftKey); return true; }
      if (k === "ArrowRight") { this.moveWord(1, e.shiftKey); return true; }
      if (k === "Home") { this.moveDocBoundary(-1, e.shiftKey); return true; }
      if (k === "End") { this.moveDocBoundary(1, e.shiftKey); return true; }
      if (k === "Enter") { this.toggleTodoAtCaret(); return true; }
      // Block reorder — Notion/AppFlowy parity.
      if (e.shiftKey && k === "ArrowUp") { this.moveBlock(-1); return true; }
      if (e.shiftKey && k === "ArrowDown") { this.moveBlock(1); return true; }
      switch ((k ?? "").toLowerCase()) {
        case "a": this.selectAll(); return true;
        case "c": this.copy(false); return true;
        case "x": if (e.shiftKey) { this.applyFormat("strike"); return true; } this.copy(true); return true;
        case "v": this.paste(e.shiftKey); return true;
        case "z": if (e.shiftKey) this.redo(); else this.undo(); return true;
        case "y": this.redo(); return true;
        case "b": this.applyFormat("bold"); return true;
        case "i": this.applyFormat("italic"); return true;
        case "u": this.applyFormat("underline"); return true;
        case "e": this.applyFormat("code"); return true;
        case "s": if (e.shiftKey) { this.applyFormat("strike"); return true; } return false;
        case "\\": this.clearFormat(); return true;
        default: return false;
      }
    }
    switch (k) {
      case "Backspace": this.backspace(); return true;
      case "Delete": this.forwardDelete(); return true;
      case "Enter":
        if (e.shiftKey) { this.mutate("type"); this.insertRaw("\n"); this.inserted(); }
        else this.splitBlock();
        return true;
      case "Escape": this.slash = null; this.toolbar = null; this.anchor = null; this.pending = null; return true;
      case "ArrowLeft":
        if (e.altKey) this.moveWord(-1, e.shiftKey); else this.moveCaret(-1, e.shiftKey);
        return true;
      case "ArrowRight":
        if (e.altKey) this.moveWord(1, e.shiftKey); else this.moveCaret(1, e.shiftKey);
        return true;
      case "ArrowUp": this.moveLine(-1, e.shiftKey); return true;
      case "ArrowDown": this.moveLine(1, e.shiftKey); return true;
      case "Home": this.moveHome(e.shiftKey); return true;
      case "End": this.moveEnd(e.shiftKey); return true;
      case "PageUp": this.pageMove(-1, e.shiftKey); return true;
      case "PageDown": this.pageMove(1, e.shiftKey); return true;
      case "Tab": this.mutate("type"); this.insertRaw("  "); this.inserted(); return true;
      default:
        // With native text input active, printable chars (including space)
        // arrive via textinput — keydown chars only serve synthetic events.
        if (k && k.length === 1 && !this.textInputActive) {
          this.insertChar(k);
          return true;
        }
        return false;
    }
  }

  private selectAll(): void {
    if (this.doc.blocks.length === 0) return;
    this.pending = null;
    this.anchor = { block: 0, offset: 0 };
    const last = this.doc.blocks.length - 1;
    this.caret = { block: last, offset: blockText(this.doc.blocks[last]!).length };
    this.showToolbar();
  }

  private extendSelection(extend: boolean): void {
    // Any caret move drops armed typing styles (Notion parity).
    this.pending = null;
    if (extend) {
      if (this.anchor === null) this.anchor = { ...this.caret };
      this.showToolbar();
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
    // Never park inside a surrogate pair — step over the whole codepoint.
    const nb = this.doc.blocks[block];
    const t = nb ? blockText(nb) : "";
    if (offset > 0 && offset < t.length && isLowSurrogate(t.charCodeAt(offset)) && isHighSurrogate(t.charCodeAt(offset - 1))) {
      offset += dir;
    }
    this.caret = { block, offset: Math.max(0, offset) };
    this.goalX = null;
    this.blinkT = 0;
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
  }

  private moveHome(shift: boolean): void {
    if (!this.layout) return;
    this.extendSelection(shift);
    const li = this.layouter.lineIndexOf(this.layout, this.caret);
    const line = this.layout.lines[Math.max(0, li)]!;
    this.caret = { block: line.block, offset: line.blockStart };
    this.blinkT = 0;
  }

  private moveEnd(shift: boolean): void {
    if (!this.layout) return;
    this.extendSelection(shift);
    const li = this.layouter.lineIndexOf(this.layout, this.caret);
    const line = this.layout.lines[Math.max(0, li)]!;
    this.caret = { block: line.block, offset: line.blockEnd };
    this.blinkT = 0;
  }

  /** Ctrl+Home / Ctrl+End — jump to the document boundary. */
  private moveDocBoundary(dir: -1 | 1, shift: boolean): void {
    this.extendSelection(shift);
    if (dir < 0) {
      this.caret = { block: 0, offset: 0 };
    } else {
      const last = this.doc.blocks.length - 1;
      this.caret = { block: Math.max(0, last), offset: last >= 0 ? blockText(this.doc.blocks[last]!).length : 0 };
    }
    this.goalX = null;
    this.blinkT = 0;
  }

  /** PageUp/PageDown — move the caret ~one viewport height, keeping goal-x. */
  private pageMove(dir: -1 | 1, shift: boolean): void {
    if (!this.layout) return;
    this.extendSelection(shift);
    const cr = this.layouter.caretRect(this.layout, this.caret);
    const gx = this.goalX ?? cr.x;
    const pageH = Math.max(80, this.rect.h - PAD_TOP - TITLE_H - 24);
    const dy = cr.y + dir * pageH;
    this.caret = this.layouter.posAt(this.layout, gx, dy);
    this.goalX = gx;
    this.blinkT = 0;
  }

  /** Ctrl+Enter — toggle the todo checkbox under the caret. */
  private toggleTodoAtCaret(): void {
    const b = this.blockOf(this.caret);
    if (b?.kind !== "todo") return;
    this.mutate("toggle");
    b.checked = !b.checked;
    if (this.animationsOn) this.todoAnim = { block: b.id, checked: b.checked!, t0: this.time };
    this.inserted();
  }

  // ── Frame ────────────────────────────────────────────────────────────────

  tick(dt: number): void {
    // Wall-clock delta: the frame governor services an idle app with sparse
    // renderOnce() calls, and the engine caps passed dt at 0.1s — anim clocks
    // must track real elapsed or blink/fades crawl while asleep.
    const nowMs = performance.now();
    const rdt = this.lastTickMs > 0 ? Math.min(0.5, (nowMs - this.lastTickMs) / 1000) : dt;
    this.lastTickMs = nowMs;
    this.time += rdt;
    this.scrollY += (this.scrollTarget - this.scrollY) * Math.min(1, dt * SCROLL_LERP);
    if (Math.abs(this.scrollTarget - this.scrollY) < 0.1) this.scrollY = this.scrollTarget;
    if (Math.abs(this.scrollTarget - this.scrollY) > 0.5) this.scrollActiveT = this.time;
    this.blinkT += rdt;

    if (this.flashAnim && this.time - this.flashAnim.t0 > FLASH_DUR) this.flashAnim = null;
    if (this.todoAnim && this.time - this.todoAnim.t0 > CHECK_DUR) this.todoAnim = null;

    // Drag auto-scroll near the top/bottom viewport edges (text-select and
    // block-drag alike — block drags re-derive the insertion slot instead).
    if (this.dragging || this.blockDrag) {
      const top = this.rect.y + PAD_TOP + TITLE_H;
      const bot = this.rect.y + this.rect.h - 8;
      let v = 0;
      if (this.dragY < top) v = -Math.min(1, (top - this.dragY) / 60) * 700;
      else if (this.dragY > bot) v = Math.min(1, (this.dragY - bot) / 60 + 0.15) * 700;
      if (v !== 0) {
        this.scrollTarget = clamp(this.scrollTarget + v * dt, 0, this.maxScroll());
        this.scrollActiveT = this.time;
        if (this.blockDrag) {
          this.blockDrag.insert = this.blockInsertIndex(this.docY(this.dragY));
          this.blockDrag.moved = true;
        } else {
          if (this.anchor === null) this.anchor = { ...this.caret };
          this.caret = this.posAtSurface(this.dragX, this.dragY);
        }
      }
    }

    // Relayout BEFORE caret math — caretRect on a stale layout returns {0,0}
    // for positions in newly-created blocks, which snaps the scroll to top.
    if (this.dirty && this.rect.w > 0 && this.cache.ready) {
      this.layout = this.layouter.layout(this.doc, Math.max(80, this.rect.w - PAD_X * 2), this.theme);
      this.dirty = false;
    }

    if (this.layout) {
      const r = this.layouter.caretRect(this.layout, this.caret);
      this.caretX = r.x; this.caretY = r.y; this.caretH = r.h;
      const snap = this.caretShownX === 0 && this.caretShownY === 0;
      const k = Math.min(1, dt * CARET_LERP);
      this.caretShownX += (this.caretX - this.caretShownX) * k;
      this.caretShownY += (this.caretY - this.caretShownY) * k;
      // Exponential lerp converges without ever landing — snap under half a
      // pixel so animating() can report the move finished.
      if (Math.abs(this.caretShownX - this.caretX) < 0.5) this.caretShownX = this.caretX;
      if (Math.abs(this.caretShownY - this.caretY) < 0.5) this.caretShownY = this.caretY;
      if (snap) { this.caretShownX = this.caretX; this.caretShownY = this.caretY; }
      // Keep the caret in view — but only after it actually moves, so opening
      // a doc (caret placed at end) doesn't yank the scroll position.
      const ck = `${this.caret.block}:${this.caret.offset}`;
      if (ck !== this.lastCaretKey) {
        this.lastCaretKey = ck;
        const cy = this.caretY + PAD_TOP + TITLE_H;
        const vis = this.rect.h - PAD_TOP;
        if (cy - this.scrollY > vis) this.scrollTarget = cy - vis + 8;
        if (cy - this.scrollY < PAD_TOP + TITLE_H) this.scrollTarget = Math.max(0, cy - PAD_TOP - TITLE_H - 8);
        this.scrollTarget = clamp(this.scrollTarget, 0, this.maxScroll());
      }
    }
  }

  hasContent(): boolean {
    return this.active && this.cache.ready && !this.disposed;
  }

  /** Time-driven visuals in flight — the frame governor holds the render
   *  loop awake until this clears. Caret blink is deliberately excluded
   *  (wantsBlink() services it at the idle cadence). */
  animating(): boolean {
    if (!this.active || this.disposed) return false;
    if (this.scrollY !== this.scrollTarget) return true;
    if (this.caretShownX !== this.caretX || this.caretShownY !== this.caretY) return true;
    if (this.dragging || this.blockDrag || this.scrollDrag) return true;
    if (this.flashAnim || this.todoAnim) return true;
    if (this.slash && this.time - this.slash.t0 < POP_DUR) return true;
    if (this.toolbar && this.time - this.toolbar.t0 < POP_DUR) return true;
    if (this.ctxMenu && this.time - this.ctxMenu.t0 < POP_DUR) return true;
    if (this.time - this.scrollActiveT < 1.3) return true; // scrollbar fadeout
    return false;
  }

  /** A blinking caret is visible — serviced at ~2fps while the loop sleeps. */
  wantsBlink(): boolean {
    return this.active && this.focused && !this.disposed;
  }

  render(pass: GPURenderPassEncoder, surfaceW: number, surfaceH: number): void {
    if (this.rect.w <= 0) return;
    const p = this.pass;
    const t = this.theme;
    p.begin();
    p.rect(this.rect.x, this.rect.y, this.rect.w, this.rect.h, t.bg);
    if (!this.layout) {
      p.render(pass, surfaceW, surfaceH, this.atlas, this.time);
      return;
    }

    const ox = this.rect.x + PAD_X;
    const oy = this.rect.y + PAD_TOP + TITLE_H - this.scrollY;
    const viewTop = this.rect.y;
    const viewBot = this.rect.y + this.rect.h;

    // Page title header — fixed (doesn't scroll), matches board/canvas views.
    this.drawTitle(p, t);
    this.drawPlaceholder(p, t, ox, oy);

    // Everything past this point is scrolling body content — scissor-clip it
    // below the title strip so it can't paint over the header.
    const bodyStart = p.quadCount;
    const clipY = this.rect.y + PAD_TOP + TITLE_H - 12;

    // Block-level decorations first (bg must not cover earlier lines' text).
    for (const lb of this.layout.blocks) {
      const by = oy + lb.y;
      if (by + lb.height < viewTop || by > viewBot) continue;
      const block = this.doc.blocks[lb.block]!;
      if (block.kind === "codeblock") {
        p.roundedRect(this.rect.x + 8, by - 4, this.rect.w - 16, lb.height + 8, 8, t.codeBg);
      } else if (block.kind === "callout") {
        p.roundedRect(this.rect.x + 8, by - 4, this.rect.w - 16, lb.height + 8, 8, t.calloutBg);
      } else if (block.kind === "quote") {
        p.roundedRect(ox - 20, by + 4, 3, lb.height - 8, 1.5, t.quoteBar);
      }
      // Block drag — tint the source block so it reads as "picked up".
      if (this.blockDrag && this.blockDrag.src === lb.block) {
        p.roundedRect(this.rect.x + 8, by - 4, this.rect.w - 16, lb.height + 8, 8,
          [t.caret[0], t.caret[1], t.caret[2], 0.10]);
      }

      // Transform flash — a soft highlight that fades after a markdown
      // shortcut or slash command retypes the block.
      if (this.flashAnim && this.flashAnim.block === block.id) {
        const fade = 1 - clamp01((this.time - this.flashAnim.t0) / FLASH_DUR);
        if (fade > 0) {
          p.roundedRect(this.rect.x + 8, by - 4, this.rect.w - 16, lb.height + 8, 8,
            [t.caret[0], t.caret[1], t.caret[2], 0.16 * fade]);
        }
      }
    }

    // Selection — under the text. Anchor may trail the caret (backwards
    // selection) — normalize the ends before asking the layouter.
    if (this.anchor !== null) {
      const [a, b] = docCompare(this.anchor, this.caret) <= 0
        ? [this.anchor, this.caret] : [this.caret, this.anchor];
      const rects = this.layouter.selectionRects(this.layout, a, b);
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
        const segW = Math.abs((seg.run.clusterOffsets[seg.end] ?? 0) - (seg.run.clusterOffsets[seg.start] ?? 0));
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
        this.drawSegmentText(p, seg, block, line, ox, oy);
      }
    }

    // Caret — blink: 0.53s on / 0.47s off.
    if (this.focused && this.blinkT % 1.0 < 0.53) {
      p.roundedRect(ox + this.caretShownX - 1, oy + this.caretShownY, 2, this.caretH, 1, t.caret);
    }

    // Gutter drag grip + block drop indicator — body content (scissored).
    this.renderGrip(p, ox, oy, t);
    this.renderBlockDragIndicator(p, ox, oy, t);

    const bodyEnd = p.quadCount;

    // Slash menu + format toolbar + scrollbar overlays — unclipped.
    this.renderSlashMenu(p, ox, oy, t);
    this.renderToolbar(p, t);
    this.renderScrollbar(p, t);
    this.renderCtxMenu(p, t);

    p.renderRanges(pass, surfaceW, surfaceH, this.atlas, this.time, [
      { start: 0, end: bodyStart },
      { start: bodyStart, end: bodyEnd, scissor: [this.rect.x, clipY, this.rect.w, this.rect.y + this.rect.h - clipY] },
      { start: bodyEnd, end: p.quadCount },
    ]);
  }

  /** Draw one laid segment's text slice plus its underline/strike marks. */
  private drawSegmentText(p: GpuTextPass, seg: LaidSegment, block: Block, line: LaidLine, ox: number, oy: number): void {
    const text = seg.runText.slice(seg.start, seg.end);
    if (!text) return;
    const t = this.theme;
    let color = (seg.style.code && block.kind !== "codeblock" ? t.codeText : seg.style.color) ?? t.text;
    // Completed todos render dimmed.
    if (block.kind === "todo" && block.checked) color = [color[0], color[1], color[2], color[3] * 0.55];
    const baselineY = oy + line.baseline;
    const co = seg.run.clusterOffsets;
    const segW = Math.abs((co[seg.end] ?? 0) - (co[seg.start] ?? 0));

    const chunk = this.cache.getChunk(seg.faceKey, seg.sizePx, text);
    if (chunk?.region) {
      // Snap the quad origin to whole pixels — a coverage-atlas blit is
      // sharpest when it lands on integer device pixels.
      const imgX = Math.round(ox + seg.x + chunk.inkX);
      const imgY = Math.round(baselineY - chunk.baselineInBitmap);
      p.text(imgX, imgY, chunk.w, chunk.h, { region: chunk.region, atlasSize: this.atlas.size, color: chunk.color }, color);
    }

    const penX = ox + seg.x;
    if (seg.style.underline) {
      p.rect(penX, baselineY + 2, segW, 1.5, color);
    }
    if (seg.style.strikethrough) {
      p.rect(penX, baselineY - seg.run.ascent * 0.32, segW, 1.5, color);
    }
  }

  /** Thin scrollbar on the right edge — fades in while scrolling, hides idle. */
  private renderScrollbar(p: GpuTextPass, t: EditorTheme): void {
    const max = this.maxScroll();
    if (max <= 0) return;
    const idle = this.time - this.scrollActiveT;
    const a = this.scrollDrag ? 1 : clamp01(1 - (idle - 0.9) / 0.35);
    if (a <= 0) return;
    const trackH = this.rect.h - 8;
    const total = (this.layout?.height ?? 0) + PAD_TOP + TITLE_H + PAD_BOTTOM;
    const thumbH = Math.max(28, trackH * (this.rect.h / Math.max(total, 1)));
    const ty = this.rect.y + 4 + (trackH - thumbH) * (this.scrollY / max);
    p.roundedRect(this.rect.x + this.rect.w - 5, ty, 3, thumbH, 1.5,
      [t.text[0], t.text[1], t.text[2], 0.4 * a]);
  }

  private pageTitle(): string {
    const s = store.getState();
    const p = s.activePageId ? s.pages[s.activePageId] : null;
    return (p?.title || "").trim();
  }

  /** Fixed page title above the document column (Notion/AppFlowy style). */
  private drawTitle(p: GpuTextPass, t: EditorTheme): void {
    const title = this.pageTitle();
    const shown = title || "Untitled";
    const chunk = this.cache.getChunk("inter:600:normal", 24, shown);
    const run = this.cache.getRun("inter:600:normal", 24, shown);
    if (!chunk) return;
    const baseline = this.rect.y + PAD_TOP - 8 + (run?.ascent ?? 19);
    const color = title ? t.text : t.textMuted;
    if (chunk.region) {
      p.text(Math.round(this.rect.x + PAD_X + chunk.inkX), Math.round(baseline - chunk.baselineInBitmap),
        chunk.w, chunk.h, { region: chunk.region, atlasSize: this.atlas.size }, color);
    }
  }

  /** Ghost hint shown where the caret sits when the document is empty —
   *  keeps fresh pages from looking broken. */
  private drawPlaceholder(p: GpuTextPass, t: EditorTheme, ox: number, oy: number): void {
    const empty = this.doc.blocks.length === 0
      || this.doc.blocks.every((b) => b.spans.every((sp) => !sp.text));
    if (!empty || !this.layout?.lines.length) return;
    const hint = "Type '/' for commands, or just start writing";
    const chunk = this.cache.getChunk("inter:400:normal", 15, hint);
    if (!chunk?.region) return;
    const line = this.layout.lines[0]!;
    const baseline = oy + line.baseline;
    p.text(Math.round(ox + chunk.inkX), Math.round(baseline - chunk.baselineInBitmap),
      chunk.w, chunk.h, { region: chunk.region, atlasSize: this.atlas.size }, t.textMuted);
  }

  private drawMarker(blockIdx: number, line: { baseline: number; blockFirst: boolean }, ox: number, oy: number, p: GpuTextPass): void {
    if (!line.blockFirst) return; // marker on the block's first line only
    const block = this.doc.blocks[blockIdx]!;
    const label = `${block.num ?? 1}.`;
    const chunk = this.cache.getChunk("inter:400:normal", 16, label);
    if (chunk?.region) {
      p.text(ox - 22 - chunk.w, line.baseline + oy - chunk.baselineInBitmap,
        chunk.w, chunk.h, { region: chunk.region, atlasSize: this.atlas.size }, this.theme.bulletColor);
    }
  }

  private drawCheckbox(block: Block, line: { y: number; height: number; baseline: number; blockFirst: boolean },
    ox: number, oy: number, p: GpuTextPass, t: EditorTheme): void {
    if (!line.blockFirst) return;
    const s = 14;
    const x = ox - 24;
    const y = oy + line.baseline - s / 2 - 2;
    // Fresh toggle → pop the box + scale the check in.
    const anim = this.animationsOn && this.todoAnim && this.todoAnim.block === block.id
      ? clamp01((this.time - this.todoAnim.t0) / CHECK_DUR) : 1;
    const pop = anim < 1 ? easeOutBack(anim) : 1;
    const boxS = s * (0.85 + 0.15 * pop);
    const bx = x + (s - boxS) / 2;
    const by = y + (s - boxS) / 2;
    // Border ring.
    p.roundedRect(bx, by, boxS, boxS, 4, block.checked ? t.caret : [t.bulletColor[0], t.bulletColor[1], t.bulletColor[2], 0.55]);
    // Inner fill — unchecked shows the page background through the ring.
    p.roundedRect(bx + 1.5, by + 1.5, boxS - 3, boxS - 3, 3,
      block.checked ? t.caret : t.bg);
    // Expanding pulse ring on toggle.
    if (anim < 1) {
      const ring = s * (0.6 + 0.8 * anim);
      p.roundedRect(x + (s - ring) / 2, y + (s - ring) / 2, ring, ring, ring / 2,
        [t.caret[0], t.caret[1], t.caret[2], 0.5 * (1 - anim)]);
    }
    if (block.checked) {
      const chk = this.cache.getChunk("inter:700:normal", 12, "✓");
      if (chk?.region) {
        const cw = chk.w * pop;
        const chh = chk.h * pop;
        p.text(x + (s - cw) / 2, y + (s - chh) / 2 - 1, cw, chh,
          { region: chk.region, atlasSize: this.atlas.size }, [1, 1, 1, anim]);
      }
    }
  }

  private renderSlashMenu(p: GpuTextPass, ox: number, oy: number, t: EditorTheme): void {
    if (!this.slash || this.slash.items.length === 0) { if (this.slash) this.slash.rect = null; return; }
    const itemH = 30;
    const w = 260;
    const h = this.slash.items.length * itemH + 12;
    // Below the caret; flip above if near the bottom.
    const cx = ox + this.caretShownX;
    const cy = oy + this.caretShownY + this.caretH + 6;
    const x = clamp(cx, this.rect.x + 4, this.rect.x + this.rect.w - w - 4);
    const y = cy + h > this.rect.y + this.rect.h - 4 ? oy + this.caretShownY - h - 6 : cy;
    this.slash.rect = { x, y, w, h };

    // Rise-in animation: fade + small upward drift.
    const e = this.animationsOn ? easeOutCubic(clamp01((this.time - this.slash.t0) / POP_DUR)) : 1;
    const dy = (1 - e) * 5;
    const fade = (c: Rgba): Rgba => [c[0], c[1], c[2], c[3] * e];

    // Hairline border under the fill so light menus read against the page.
    if (t.toolbarBg[0] > 0.5) {
      p.roundedRect(x - 1, y + dy - 1, w + 2, h + 2, 9, fade(t.divider));
    }
    p.roundedRect(x, y + dy, w, h, 8, fade(t.toolbarBg));
    p.roundedRect(x, y + dy, w, 1, 0, fade(t.divider));
    for (let i = 0; i < this.slash.items.length; i++) {
      const item = this.slash.items[i]!;
      const iy = y + dy + 6 + i * itemH;
      if (i === this.slash.index) {
        p.roundedRect(x + 4, iy, w - 8, itemH, 6, fade([0.30, 0.42, 0.75, 0.35]));
      }
      const label = this.cache.getChunk("inter:500:normal", 14, item.label);
      if (label?.region) {
        p.text(x + 12, iy + 4, label.w, label.h, { region: label.region, atlasSize: this.atlas.size }, fade(t.text));
      }
      const hint = this.cache.getChunk("inter:400:normal", 12, item.hint);
      if (hint?.region) {
        p.text(x + w - hint.w - 12, iy + 9, hint.w, hint.h, { region: hint.region, atlasSize: this.atlas.size }, fade(t.textMuted));
      }
    }
  }

  /** Whether the whole current selection already carries format `id`. */
  private selectionHas(id: string): boolean {
    if (this.anchor === null) return false;
    const a = docCompare(this.anchor, this.caret) <= 0 ? this.anchor : this.caret;
    const b = docCompare(this.anchor, this.caret) <= 0 ? this.caret : this.anchor;
    for (let bi = a.block; bi <= b.block; bi++) {
      const blk = this.doc.blocks[bi]!;
      const s = bi === a.block ? a.offset : 0;
      const e = bi === b.block ? b.offset : blockText(blk).length;
      if (e > s && !rangeHasStyle(blk, s, e, id)) return false;
    }
    return true;
  }

  private renderToolbar(p: GpuTextPass, t: EditorTheme): void {
    if (this.anchor === null) { this.toolbar = null; return; }
    // Lazily appear whenever a non-collapsed selection exists — covers
    // keyboard-made selections (shift+arrows/home/end) which never hit the
    // pointer-up showToolbar path. Suppressed while the context menu is up —
    // otherwise it re-pops on the same selection every frame.
    if (!this.ctxMenu && !this.toolbar && docCompare(this.anchor, this.caret) !== 0) this.showToolbar();
    if (!this.toolbar) return;
    // Keep the rect glued to the selection while it keeps changing (e.g.
    // holding shift+arrow grows the highlight under a keyboard user's hand).
    const [sa, sb] = docCompare(this.anchor, this.caret) <= 0
      ? [this.anchor, this.caret] : [this.caret, this.anchor];
    if (docCompare(sa, this.toolbar.forA) !== 0 || docCompare(sb, this.toolbar.forB) !== 0) {
      this.showToolbar();
    }
    if (!this.toolbar) return;
    const r = this.toolbar.rect;
    const e = this.animationsOn ? easeOutCubic(clamp01((this.time - this.toolbar.t0) / POP_DUR)) : 1;
    const dy = (1 - e) * 4;
    const fade = (c: Rgba): Rgba => [c[0], c[1], c[2], c[3] * e];
    // Light toolbars need a hairline border to read against the page —
    // draw the border as a 1px-larger rect behind the fill.
    if (t.toolbarBg[0] > 0.5) {
      p.roundedRect(r.x - 1, r.y + dy - 1, r.w + 2, r.h + 2, 9, fade(t.divider));
    }
    p.roundedRect(r.x, r.y + dy, r.w, r.h, 8, fade(t.toolbarBg));
    let x = r.x + 6;
    for (const btn of TOOLBAR_BTNS) {
      if (this.selectionHas(btn.id)) {
        p.roundedRect(x + 1, r.y + dy + 3, btn.w - 2, r.h - 6, 5,
          fade([t.selection[0], t.selection[1], t.selection[2], 0.35]));
      }
      const style = btn.id === "bold" ? "inter:700:normal" : btn.id === "italic" ? "inter:400:italic" : "inter:400:normal";
      const label = this.cache.getChunk(style, 13, btn.label);
      if (label?.region) {
        p.text(x + (btn.w - label.w) / 2, r.y + dy + (r.h - label.h) / 2 + 1, label.w, label.h,
          { region: label.region, atlasSize: this.atlas.size }, fade(t.toolbarText));
      }
      x += btn.w;
    }
  }

  /** Six-dot drag grip in the left gutter for the hovered (or dragged)
   *  block — AppFlowy/Notion block handle. */
  private renderGrip(p: GpuTextPass, ox: number, oy: number, t: EditorTheme): void {
    this.gripRect = null;
    const hb = this.blockDrag ? this.blockDrag.src : this.hoverBlock;
    if (hb < 0 || !this.layout) return;
    const lb = this.layout.blocks[hb];
    if (!lb) return;
    // Center the grip on the block's first line.
    const first = this.layout.lines.find(l => l.block === hb);
    const cy = oy + lb.y + (first ? first.height : lb.height) / 2;
    const gx = ox - 46;
    this.gripRect = { x: gx, y: cy - 11, w: 24, h: 22 };
    const hot = this.gripHot || this.blockDrag !== null;
    if (hot) {
      p.roundedRect(gx, cy - 11, 24, 22, 5, [t.text[0], t.text[1], t.text[2], 0.09]);
    }
    const a = hot ? 0.8 : 0.45;
    const c: Rgba = [t.textMuted[0], t.textMuted[1], t.textMuted[2], a];
    for (let r = 0; r < 3; r++) {
      for (let cIdx = 0; cIdx < 2; cIdx++) {
        p.roundedRect(gx + 6 + cIdx * 8, cy - 7 + r * 6, 3.4, 3.4, 1.7, c);
      }
    }
  }

  /** Horizontal drop line + leading nub at the block insertion slot. */
  private renderBlockDragIndicator(p: GpuTextPass, ox: number, oy: number, t: EditorTheme): void {
    if (!this.blockDrag || !this.blockDrag.moved) return;
    const iy = oy + this.insertLineY(this.blockDrag.insert);
    p.roundedRect(ox - 6, iy - 1.5, this.rect.w - PAD_X * 2 + 6, 3, 1.5, t.caret);
    p.roundedRect(ox - 12, iy - 4.5, 8, 8, 4, t.caret);
  }

  /** Right-click / block-action menu with the "Turn into" type submenu. */
  private renderCtxMenu(p: GpuTextPass, t: EditorTheme): void {
    const m = this.ctxMenu;
    if (!m) return;
    const rowH = MENU_ROW_H;
    const h = m.rows.reduce((n, r) => n + ("sep" in r ? MENU_SEP_H : rowH), 0) + MENU_PAD * 2;
    const w = MENU_W;
    const x = clamp(m.x, this.rect.x + 4, Math.max(this.rect.x + 4, this.rect.x + this.rect.w - w - 4));
    const y = m.y + h > this.rect.y + this.rect.h - 4 ? Math.max(this.rect.y + 4, this.rect.y + this.rect.h - h - 4) : m.y;
    m.rect = { x, y, w, h };

    const e = this.animationsOn ? easeOutCubic(clamp01((this.time - m.t0) / POP_DUR)) : 1;
    const dy = (1 - e) * 4;
    const fade = (c: Rgba): Rgba => [c[0], c[1], c[2], c[3] * e];
    if (t.toolbarBg[0] > 0.5) {
      p.roundedRect(x - 1, y + dy - 1, w + 2, h + 2, 9, fade(t.divider));
    }
    p.roundedRect(x, y + dy, w, h, 8, fade(t.toolbarBg));

    let ry = y + dy + MENU_PAD;
    for (let i = 0; i < m.rows.length; i++) {
      const row = m.rows[i]!;
      if ("sep" in row) {
        p.rect(x + 10, ry + 4, w - 20, 1, fade(t.divider));
        ry += MENU_SEP_H;
        continue;
      }
      if (i === m.index && !row.disabled) {
        p.roundedRect(x + 4, ry, w - 8, rowH, 5,
          fade([t.selection[0], t.selection[1], t.selection[2], 0.35]));
      }
      const color: Rgba = row.disabled
        ? [t.textMuted[0], t.textMuted[1], t.textMuted[2], 0.45 * e]
        : fade(t.text);
      const label = this.cache.getChunk("inter:400:normal", 13, row.label);
      if (label?.region) {
        p.text(x + 12, ry + (rowH - label.h) / 2 + 1, label.w, label.h,
          { region: label.region, atlasSize: this.atlas.size }, color);
      }
      if (row.hint) {
        const hint = this.cache.getChunk("inter:400:normal", 11, row.hint);
        if (hint?.region) {
          p.text(x + w - hint.w - 12, ry + (rowH - hint.h) / 2 + 1, hint.w, hint.h,
            { region: hint.region, atlasSize: this.atlas.size }, fade(t.textMuted));
        }
      }
      ry += rowH;
    }

    // "Turn into" submenu — same block-type list as the slash menu.
    if (!m.subOpen) { m.subRect = null; return; }
    const turnIdx = m.rows.findIndex(r => !("sep" in r) && r.id === "turn");
    const sw = SUB_W;
    const sh = SLASH_ITEMS.length * rowH + MENU_PAD * 2;
    const sx = x + w + 2 + sw > this.rect.x + this.rect.w - 4 ? x - sw - 2 : x + w + 2;
    const sy = clamp(this.menuRowTop(m, Math.max(0, turnIdx)) + dy - 2,
      this.rect.y + 4, Math.max(this.rect.y + 4, this.rect.y + this.rect.h - sh - 4));
    m.subRect = { x: sx, y: sy, w: sw, h: sh };
    if (t.toolbarBg[0] > 0.5) {
      p.roundedRect(sx - 1, sy - 1, sw + 2, sh + 2, 9, fade(t.divider));
    }
    p.roundedRect(sx, sy, sw, sh, 8, fade(t.toolbarBg));
    const curKind = this.doc.blocks[clamp(m.pos.block, 0, Math.max(0, this.doc.blocks.length - 1))]?.kind;
    for (let i = 0; i < SLASH_ITEMS.length; i++) {
      const item = SLASH_ITEMS[i]!;
      const iy = sy + MENU_PAD + i * rowH;
      if (i === m.subIndex) {
        p.roundedRect(sx + 4, iy, sw - 8, rowH, 5,
          fade([t.selection[0], t.selection[1], t.selection[2], 0.35]));
      }
      const label = this.cache.getChunk("inter:400:normal", 13, item.label);
      if (label?.region) {
        p.text(sx + 12, iy + (rowH - label.h) / 2 + 1, label.w, label.h,
          { region: label.region, atlasSize: this.atlas.size }, fade(t.text));
      }
      // Dot marks the target block's current kind.
      if (item.kind === curKind) {
        p.roundedRect(sx + sw - 18, iy + rowH / 2 - 3, 6, 6, 3, fade(t.caret));
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.textInputUnsub?.();
    if (this.ownsCache) {
      this.cache.dispose();
      this.atlas.destroy();
    }
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

interface FormatDef {
  has: (s: TextStyle) => boolean;
  on: Partial<TextStyle>;
  off: Partial<TextStyle>;
}

const FORMAT: Record<string, FormatDef> = {
  bold:      { has: (s) => s.weight >= 700, on: { weight: 700 }, off: { weight: 400 } },
  italic:    { has: (s) => !!s.italic, on: { italic: true }, off: { italic: false } },
  underline: { has: (s) => !!s.underline, on: { underline: true }, off: { underline: false } },
  strike:    { has: (s) => !!s.strikethrough, on: { strikethrough: true }, off: { strikethrough: false } },
  code:      { has: (s) => !!s.code, on: { code: true }, off: { code: false } },
};

function rangeHasStyle(b: Block, start: number, end: number, id: string): boolean {
  const f = FORMAT[id];
  if (!f) return false;
  let pos = 0;
  let all = true;
  let seen = false;
  for (const sp of b.spans) {
    const s0 = pos;
    const s1 = pos + sp.text.length;
    if (s1 > start && s0 < end) {
      seen = true;
      if (!f.has(sp.style)) all = false;
    }
    pos = s1;
  }
  return seen && all;
}

function inside(x: number, y: number, r: { x: number; y: number; w: number; h: number }): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

function isHighSurrogate(c: number): boolean { return c >= 0xD800 && c <= 0xDBFF; }
function isLowSurrogate(c: number): boolean { return c >= 0xDC00 && c <= 0xDFFF; }

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function easeOutBack(t: number): number {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
}

// ── Markdown paste ──────────────────────────────────────────────────────────

interface ParsedBlock {
  kind: BlockKind;
  text: string;
  checked?: boolean;
  num?: number;
  lang?: string;
}

/** Parse pasted text into typed blocks when it looks like markdown — i.e.
 *  the FIRST line carries a block marker ("# ", "- ", "```", "1. ", "> "…).
 *  Returns null for plain prose so paste stays verbatim. */
function parseMarkdownLines(text: string): ParsedBlock[] | null {
  const lines = text.split("\n");
  for (; lines.length && lines[lines.length - 1] === "";) lines.pop();
  if (lines.length === 0) return null;

  const itemFor = (line: string): ParsedBlock | null => {
    let m = line.match(/^(#{1,3})\s+(.*)$/);
    if (m) return { kind: m[1]!.length === 1 ? "h1" : m[1]!.length === 2 ? "h2" : "h3", text: m[2]! };
    if ((m = line.match(/^>\s?(.*)$/))) return { kind: "quote", text: m[1]! };
    if ((m = line.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/)))
      return { kind: "todo", text: m[2]!, checked: m[1]!.toLowerCase() === "x" };
    if ((m = line.match(/^[-*+•]\s+(.*)$/))) return { kind: "bullet", text: m[1]! };
    if ((m = line.match(/^(\d{1,9})[.)]\s+(.*)$/))) return { kind: "number", text: m[2]!, num: parseInt(m[1]!, 10) || 1 };
    if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return { kind: "divider", text: "" };
    return null;
  };

  // Require a marker on the first line — markdown conversion is opt-in by
  // shape, so pasting regular prose never restructures blocks.
  if (!itemFor(lines[0]!) && !lines[0]!.startsWith("```")) return null;

  const items: ParsedBlock[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      for (; i < lines.length && !/^```\s*$/.test(lines[i]!);) body.push(lines[i++]!);
      i++; // consume closing fence (or run off the end)
      items.push({ kind: "codeblock", text: body.join("\n"), lang: fence[1] || "ts" });
      continue;
    }
    items.push(itemFor(line) ?? { kind: "paragraph", text: line });
    i++;
  }
  return items.length ? items : null;
}

export function darkTheme(): EditorTheme {
  return {
    bg: [0x19 / 255, 0x1b / 255, 0x1e / 255, 1],
    text: [0.82, 0.84, 0.90, 1],
    textMuted: [0.55, 0.57, 0.64, 1],
    caret: [0.45, 0.62, 0.98, 1],
    selection: [0.30, 0.42, 0.75, 0.35],
    codeBg: [0.13, 0.14, 0.18, 1],
    codeText: [0.78, 0.82, 0.95, 1],
    calloutBg: [0.16, 0.19, 0.28, 1],
    quoteBar: [0.45, 0.62, 0.98, 0.9],
    divider: [0.28, 0.30, 0.36, 1],
    bulletColor: [0.55, 0.57, 0.64, 1],
    toolbarBg: [0.16, 0.17, 0.21, 0.98],
    toolbarText: [0.90, 0.91, 0.96, 1],
    link: [0.50, 0.66, 0.98, 1],
    syntax: darkSyntax,
  };
}

export function lightTheme(): EditorTheme {
  return {
    bg: [1, 1, 1, 1],
    text: [0.16, 0.17, 0.21, 1],
    textMuted: [0.45, 0.47, 0.52, 1],
    caret: [0.20, 0.42, 0.95, 1],
    selection: [0.35, 0.55, 0.98, 0.25],
    codeBg: [0.93, 0.94, 0.96, 1],
    codeText: [0.25, 0.28, 0.50, 1],
    calloutBg: [0.88, 0.91, 0.98, 1],
    quoteBar: [0.20, 0.42, 0.95, 0.9],
    divider: [0.82, 0.83, 0.87, 1],
    bulletColor: [0.45, 0.47, 0.52, 1],
    toolbarBg: [1, 1, 1, 0.98],
    toolbarText: [0.16, 0.17, 0.21, 1],
    link: [0.18, 0.40, 0.92, 1],
    syntax: lightSyntax,
  };
}
