// ============================================================================
// ui/palette.ts — command palette + workspace search, custom GPU overlay.
//
// Opens on Ctrl/Cmd+K (or the sidebar Search button). A centered modal above
// everything (order +20): query input, filtered page hits (title + content
// snippets via workspace search), and app commands. ↑↓ navigate, Enter runs,
// Esc or backdrop click closes.
// ============================================================================

import type { ScreenUiCompositor, RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import { GpuTextPass, type Rgba } from "../text/gpu-text";
import { RunCache } from "../text/run-cache";
import { TextAtlas } from "../text/atlas";
import { tokens } from "../app/theme";
import { store, type PageType } from "../app/store";
import { searchPages } from "../app/workspace";
import { createPage, openPage } from "../app/actions";

const PANEL_W = 560;
const ROW_H = 40;
const MAX_ROWS = 8;

function hex(s: string): Rgba {
  const h = s.slice(1);
  const n = parseInt(h.slice(0, 6), 16);
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
}

interface PaletteRow {
  kind: "page" | "command";
  label: string;
  sub: string | null;
  iconType: PageType | "cmd";
  run: () => void;
}

export class PaletteSurface implements ScreenUiCompositor {
  order = 20;
  private pass: GpuTextPass;
  private cache: RunCache;
  private atlas: TextAtlas;
  private unsubs: (() => void)[] = [];
  private disposed = false;
  private query = "";
  private sel = 0;
  private rows: PaletteRow[] = [];
  private blinkT = 0;
  private lastTickMs = 0;
  private rect = { x: 0, y: 0, w: 0, h: 0 };
  private bounds = { x: 0, y: 0, w: 0, h: 0 };

  constructor(private ctx: RendererModuleContext, sharedCache?: RunCache) {
    const device = ctx.getDevice();
    this.pass = new GpuTextPass(device, ctx.getFormat());
    this.cache = sharedCache ?? new RunCache(new TextAtlas(device, 2048));
    this.atlas = this.cache.atlas;
    this.installInput();
    this.refresh();
  }

  get open(): boolean {
    return store.getState().paletteOpen;
  }

  setRect(r: { x: number; y: number; w: number; h: number }): void {
    this.rect = r;
  }

  private setOpen(open: boolean): void {
    store.setState({ paletteOpen: open });
    if (open) { this.query = ""; this.sel = 0; this.refresh(); }
  }

  private refresh(): void {
    const hits = searchPages(this.query);
    const rows: PaletteRow[] = hits.map((h) => ({
      kind: "page",
      label: h.title || "Untitled",
      sub: h.snippet,
      iconType: h.type,
      run: () => openPage(h.pageId),
    }));
    const q = this.query.toLowerCase();
    const cmds: PaletteRow[] = [
      { kind: "command", label: "New document", sub: null, iconType: "doc", run: () => createPage({ type: "doc" }) },
      { kind: "command", label: "New board", sub: null, iconType: "board", run: () => createPage({ type: "board" }) },
      { kind: "command", label: "New whiteboard", sub: null, iconType: "whiteboard", run: () => createPage({ type: "whiteboard" }) },
      { kind: "command", label: "Toggle theme", sub: null, iconType: "cmd", run: () => store.setState((s) => ({ theme: s.theme === "dark" ? "light" : "dark" })) },
    ].filter((c) => !q || c.label.toLowerCase().includes(q));
    this.rows = [...rows.slice(0, MAX_ROWS - 2), ...cmds];
    if (this.sel >= this.rows.length) this.sel = Math.max(0, this.rows.length - 1);
  }

  private installInput(): void {
    const bus = this.ctx.getInputBus();

    // High priority — palette swallows input while open, Ctrl+K toggles.
    this.unsubs.push(bus.onKeyDown((e, ctrl) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        this.setOpen(!this.open);
        ctrl.stopPropagation();
        return;
      }
      if (!this.open) return;
      ctrl.stopPropagation();
      const k = e.key;
      if (k === "Escape") { this.setOpen(false); return; }
      if (k === "ArrowDown") { this.sel = Math.min(this.rows.length - 1, this.sel + 1); return; }
      if (k === "ArrowUp") { this.sel = Math.max(0, this.sel - 1); return; }
      if (k === "Enter") {
        const r = this.rows[this.sel];
        this.setOpen(false);
        r?.run();
        return;
      }
      if (k === "Backspace") { this.query = this.query.slice(0, -1); this.sel = 0; this.refresh(); return; }
      if (k.length === 1 && !e.ctrlKey && !e.metaKey) {
        this.query += k;
        this.sel = 0;
        this.refresh();
      }
    }, 10));

    this.unsubs.push(bus.onPointerDown((e, ctrl) => {
      if (!this.open) return;
      ctrl.stopPropagation();
      const b = this.bounds;
      if (e.clientX < b.x || e.clientX > b.x + b.w || e.clientY < b.y || e.clientY > b.y + b.h) {
        this.setOpen(false);
        return;
      }
      // Row click.
      const rowIdx = Math.floor((e.clientY - (b.y + 56)) / ROW_H);
      if (rowIdx >= 0 && rowIdx < Math.min(this.rows.length, MAX_ROWS)) {
        const r = this.rows[rowIdx];
        this.setOpen(false);
        r?.run();
      }
    }, 10));

    const onText = (ev: Event) => {
      if (!this.open) return;
      const s = (ev as { data?: string }).data;
      if (s) { this.query += s; this.sel = 0; this.refresh(); }
    };
    window.addEventListener("textinput", onText);
    this.unsubs.push(() => window.removeEventListener("textinput", onText));

    // Sidebar "Search" button toggles the store flag.
    let last = this.open;
    this.unsubs.push(store.subscribe((s) => {
      if (s.paletteOpen && !last) { this.query = ""; this.sel = 0; this.refresh(); }
      last = s.paletteOpen;
    }));
  }

  update(dt: number): void {
    // Wall-clock delta — see EditorSurface.tick (sparse renderOnce service).
    const nowMs = performance.now();
    const rdt = this.lastTickMs > 0 ? Math.min(0.5, (nowMs - this.lastTickMs) / 1000) : dt;
    this.lastTickMs = nowMs;
    this.blinkT += rdt;
  }

  hasContent(): boolean {
    return this.open && this.cache.ready && !this.disposed;
  }

  /** No time-driven animations — the query caret is covered by wantsBlink. */
  animating(): boolean {
    return false;
  }

  /** The query caret blinks while the palette is open. */
  wantsBlink(): boolean {
    return this.hasContent();
  }

  private text(x: number, y: number, face: string, size: number, str: string, color: Rgba): void {
    const chunk = this.cache.getChunk(face, size, str);
    if (!chunk || !chunk.region) return;
    this.pass.text(x + chunk.inkX, y, chunk.w, chunk.h,
      { region: chunk.region, atlasSize: this.atlas.size }, color);
  }

  private measure(face: string, size: number, str: string): number {
    return this.cache.getRun(face, size, str)?.advance ?? str.length * size * 0.55;
  }

  render(pass: GPURenderPassEncoder, surfaceW: number, surfaceH: number): void {
    const p = this.pass;
    const t = tokens(store.getState().theme);
    p.begin();

    // Backdrop.
    p.rect(0, 0, surfaceW, surfaceH, [0, 0, 0, 0.42]);

    const px = this.rect.x + (this.rect.w - PANEL_W) / 2;
    const py = this.rect.y + Math.max(40, this.rect.h * 0.18);
    const rowCount = Math.max(1, Math.min(this.rows.length, MAX_ROWS));
    const ph = 56 + rowCount * ROW_H + 8;
    this.bounds = { x: px, y: py, w: PANEL_W, h: ph };

    // Panel.
    p.roundedRect(px + 3, py + 6, PANEL_W, ph, 12, [0, 0, 0, 0.4]);
    p.roundedRect(px, py, PANEL_W, ph, 12, hex(t.bgElev));
    p.roundedRect(px, py, PANEL_W, ph, 12, [1, 1, 1, 0.03]);

    // Input.
    const shown = this.query || "Search or jump to…";
    const qColor = this.query ? hex(t.text) : hex(t.textFaint);
    this.text(px + 18, py + 17, "inter:400:normal", 15, shown, qColor);
    if (this.blinkT % 1 < 0.53) {
      const tw = this.measure("inter:400:normal", 15, this.query);
      p.rect(px + 18 + tw + 2, py + 16, 1.5, 18, hex(t.accent));
    }
    p.rect(px + 10, py + 50, PANEL_W - 20, 1, hex(t.lineSoft));

    // Rows.
    let ry = py + 58;
    const visible = this.rows.slice(0, MAX_ROWS);
    if (visible.length === 0) {
      this.text(px + 18, ry + 10, "inter:400:normal", 13, "No results", hex(t.textFaint));
    }
    for (let i = 0; i < visible.length; i++) {
      const r = visible[i]!;
      if (i === this.sel) {
        p.roundedRect(px + 6, ry - 2, PANEL_W - 12, ROW_H - 4, 7, hex(t.accentSoft));
      }
      // Type dot / icon glyph.
      const iconTxt = r.iconType === "doc" ? "D" : r.iconType === "board" ? "B" : r.iconType === "whiteboard" ? "W" : "→";
      const iconColor = r.iconType === "cmd" ? hex(t.textFaint) : hex(t.accentText);
      this.text(px + 18, ry + 12, "inter:600:normal", 11, iconTxt, iconColor);
      this.text(px + 38, ry + 10, "inter:500:normal", 13, r.label, hex(t.text));
      if (r.sub) {
        const avail = PANEL_W - 60 - this.measure("inter:500:normal", 13, r.label) - 20;
        let snip = r.sub;
        while (snip.length > 8 && this.measure("inter:400:normal", 11, snip + "…") > avail) snip = snip.slice(0, -1);
        this.text(px + 38 + this.measure("inter:500:normal", 13, r.label) + 12, ry + 12,
          "inter:400:normal", 11, snip + (snip === r.sub ? "" : "…"), hex(t.textFaint));
      }
      ry += ROW_H;
    }

    p.render(pass, surfaceW, surfaceH, this.atlas, this.blinkT);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.pass.destroy();
  }
}
