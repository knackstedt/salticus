/** @jsxImportSource @downdraft/engine/modules/html-ui */
// ============================================================================
// shell.tsx — top-level html-ui chrome: sidebar + topbar panels.
//
// The content region between them is left uncovered so the custom GPU
// surface (editor / board / whiteboard) receives pointer input directly.
// Panel rects are buffer-px; on resize we recompute and setRect.
// ============================================================================

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { HtmlUiContext, OsrDomEvent, UiPanelHandle } from "@downdraft/engine/modules/html-ui";
import type { AppContext } from "@downdraft/engine/app/main";
import { createLogger } from "@downdraft/engine/util/logger";
import { store } from "../app/store";
import { activatePage, closeAllTabs, closeOtherTabs, closeTab, createPage, deletePage, destroyPage, duplicatePage, openPage, renamePage, restorePage, toggleExpanded, toggleFavorite } from "../app/actions";
import { serveThumbs, setThumbUi } from "../app/thumbnails";
import { chromeCss, tokens, type ThemeTokens } from "../app/theme";
import { iconBytes } from "./icons";
import { ctxMenuMarkup, sidebarMarkup, topbarMarkup, type CtxMenuKind } from "./shell-markup";

const log = createLogger();

export interface ShellHandles {
  sidebar: UiPanelHandle;
  topbar: UiPanelHandle;
  rerender: () => void;
  layout: () => void;
}

const FONTS: Array<[string, string]> = [
  ["Inter", "ui://fonts/Inter-Regular.ttf"],
  ["Inter Medium", "ui://fonts/Inter-Medium.ttf"],
  ["Inter SemiBold", "ui://fonts/Inter-SemiBold.ttf"],
  ["Inter Bold", "ui://fonts/Inter-Bold.ttf"],
  ["JetBrains Mono", "ui://fonts/JetBrainsMono-Regular.ttf"],
  ["JetBrains Mono Medium", "ui://fonts/JetBrainsMono-Medium.ttf"],
];

function fontDir(): string {
  // Game cwd when launched via `draft dev`/`draft release`.
  const local = join(process.cwd(), "assets", "fonts");
  if (existsSync(local)) return local;
  return join(new URL("../..", import.meta.url).pathname, "assets", "fonts");
}

async function loadUiFonts(ui: HtmlUiContext): Promise<string> {
  const dir = fontDir();
  let faces = "";
  for (const [family, url] of FONTS) {
    const file = url.replace("ui://fonts/", "");
    try {
      const bytes = readFileSync(join(dir, file));
      await ui.loadResource(url, bytes);
      faces += ui.fontFaceCss(family, url);
    } catch (e) {
      log.warn("ui", `font ${file} failed to load: ${e}`);
    }
  }
  for (const [url, bytes] of iconBytes()) {
    try {
      await ui.loadResource(url, bytes);
    } catch (e) {
      log.warn("ui", `icon ${url} failed to load: ${e}`);
    }
  }
  return faces;
}

function pageCss(t: ThemeTokens, fontFaces: string): string {
  return `<style>${fontFaces}${chromeCss(t)}</style>`;
}

/** OS clipboard write — same native-window bridge the editor uses. */
function clipboardSet(text: string): void {
  const nw = (globalThis as { __nativeWindow?: { setClipboardText?: (t: string) => void } }).__nativeWindow;
  try { nw?.setClipboardText?.(text); } catch (e) { log.warn("ui", `clipboard set failed: ${e}`); }
}

export function mountShell(ui: HtmlUiContext, ctx: AppContext): ShellHandles {
  const s0 = store.getState();
  const W = ctx.surface.width;
  const H = ctx.surface.height;
  // Buffer px per CSS px — panels get zoom=dpr so doc CSS px are logical px,
  // and chrome rect dims scale up to stay logical-sized.
  const dpr0 = ctx.surface.clientWidth > 0 ? ctx.surface.width / ctx.surface.clientWidth : 1;
  const sw = s0.sidebarWidth;
  const th = s0.topbarHeight;
  store.setState({
    windowW: W,
    windowH: H,
    dpr: dpr0,
    contentRect: { x: sw * dpr0, y: th * dpr0, w: W - sw * dpr0, h: H - th * dpr0 },
  });

  let fontFaces = "";
  const fontP = loadUiFonts(ui).then((f) => {
    fontFaces = f;
    rerender();
  });
  void fontP;

  setThumbUi(ui);
  serveThumbs();

  const st = store.getState();
  const t = tokens(st.theme);

  const sidebar = ui.mount(
    wrap(pageCss(t, fontFaces) + sidebarMarkup(st), "sidebar"),
    { id: "sidebar", rect: { x: 0, y: 0, w: sw * dpr0, h: H }, z: 10, scale: 2, zoom: dpr0, smoothWheel: true },
  );
  const topbar = ui.mount(
    wrap(pageCss(t, fontFaces) + topbarMarkup(st), "topbar"),
    { id: "topbar", rect: { x: sw * dpr0, y: 0, w: W - sw * dpr0, h: th * dpr0 }, z: 10, scale: 2, zoom: dpr0 },
  );

  function layout() {
    const s = store.getState();
    const w = s.windowW, h = s.windowH, d = s.dpr;
    // Panel rects are buffer px — sidebarWidth/topbarHeight are logical px.
    sidebar.setRect({ x: 0, y: 0, w: s.sidebarWidth * d, h }, d);
    topbar.setRect({ x: s.sidebarWidth * d, y: 0, w: w - s.sidebarWidth * d, h: s.topbarHeight * d }, d);
    store.setState({
      contentRect: {
        x: s.sidebarWidth * d, y: s.topbarHeight * d,
        w: w - s.sidebarWidth * d, h: h - s.topbarHeight * d,
      },
    });
  }

  // ── Page/tab context menu + inline rename ─────────────────────────────
  //
  // The Blitz backend emits a "contextmenu" DOM event on right-click; its
  // merged data-* attrs carry the data-menu marker set on page rows/tabs in
  // shell-markup. The menu itself is a transient full-window transparent
  // panel — clicks off the menu land on its backdrop (ctx-dismiss).
  let menu: UiPanelHandle | null = null;

  store.setState({
    uiState: () => {
      const s = store.getState();
      return { renamingId: s.renamingId, renamingDraft: s.renamingDraft, ctxMenuOpen: menu !== null };
    },
  });

  const closeCtxMenu = () => { menu?.dispose(); menu = null; };

  const openCtxMenu = (pageId: string, kind: CtxMenuKind, sx: number, sy: number) => {
    closeCtxMenu();
    const s = store.getState();
    // No .sc-panel here — the menu is a transparent full-window overlay, so
    // only the .sc-menu card itself paints (its backdrop is event-only).
    menu = ui.mount(
      `<div class="sc-col" style="width:100%;height:100%">${pageCss(tokens(s.theme), fontFaces)}${ctxMenuMarkup(s, pageId, kind, sx, sy)}</div>`,
      { id: "ctxmenu", rect: { x: 0, y: 0, w: s.windowW, h: s.windowH }, z: 60, scale: 2, zoom: s.dpr },
    );
    menu.onEvent((ev) => {
      if (ev.t === "contextmenu" || (ev.t === "keydown" && ev.k === "Escape")) closeCtxMenu();
    });
  };
  ui.onDispose(closeCtxMenu);

  const commitRename = () => {
    const s = store.getState();
    if (!s.renamingId) return;
    const { renamingId, renamingDraft } = s;
    store.setState({ renamingId: null });
    renamePage(renamingId, renamingDraft.trim());
  };

  const panelEvents = (panel: UiPanelHandle) => (ev: OsrDomEvent) => {
    const s = store.getState();
    if (ev.t === "contextmenu") {
      const kind = ev.d?.menu as CtxMenuKind | undefined;
      if (kind && ev.d?.id && s.pages[ev.d.id]) {
        // ev.x/y are doc-space (logical px); panel.rect is buffer px — the
        // menu doc is logical px too, so convert the origin, not the event.
        openCtxMenu(ev.d.id, kind, panel.rect.x / s.dpr + (ev.x ?? 0), panel.rect.y / s.dpr + (ev.y ?? 0));
      }
      return;
    }
    // Pointer activity on chrome drops editor focus — the caret stops
    // blinking while the user interacts with the sidebar/topbar.
    if (ev.t === "mousedown") s.blurEditor?.();
    // Double-click pins a page into the tab strip (single click previews).
    if (ev.t === "dblclick" && ev.d?.action === "open-page" && ev.d.id) {
      openPage(ev.d.id);
      return;
    }
    if (panel === sidebar && s.renamingId) {
      // Live draft into the store — deliberately NOT part of the chrome
      // re-render key, so the input isn't rebuilt under the user's cursor.
      // Only events carrying data-rename-input belong to the rename input —
      // the "blur" of the previously-focused node arrives alongside focus().
      if (ev.t === "input" && ev.d?.["rename-input"]) { store.setState({ renamingDraft: ev.v ?? "" }); return; }
      if (ev.t === "blur" && ev.d?.["rename-input"]) { commitRename(); return; }
      if (ev.t === "keydown") {
        if (ev.k === "Enter") commitRename();
        else if (ev.k === "Escape") store.setState({ renamingId: null });
        return;
      }
    }
    if (ev.t === "keydown" && ev.k === "Escape") closeCtxMenu();
  };
  sidebar.onEvent(panelEvents(sidebar));
  topbar.onEvent(panelEvents(topbar));

  function rerender() {
    const s = store.getState();
    const css = pageCss(tokens(s.theme), fontFaces);
    sidebar.setHtml(wrap(css + sidebarMarkup(s), "sidebar"));
    topbar.setHtml(wrap(css + topbarMarkup(s), "topbar"));
    if (s.renamingId) sidebar.focus("[data-rename-input]");
  }

  // Selective re-render: only when chrome-relevant state changes.
  let lastKey = "";
  const unsub = store.subscribe((s) => {
    const key = [
      s.pages, s.rootOrder, s.activePageId, s.openTabs, s.theme, s.saveIndicator,
      s.sidebarView, s.thumbVersion, s.editorAnimations, s.renamingId, s.showBreadcrumb,
    ].map((v) => (typeof v === "object" ? JSON.stringify(v) : v)).join("|");
    if (key !== lastKey) {
      lastKey = key;
      rerender();
    }
  });
  ui.onDispose(unsub);

  ui.onResize((w, h, dpr) => {
    // onResize reports CSS px — panel rects/contentRect are buffer px.
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    store.setState({ windowW: bw, windowH: bh, dpr });
    closeCtxMenu();
    layout();
  });

  // ── Actions ──────────────────────────────────────────────────────────
  ui.onAction("new-page", (d) => {
    createPage({ type: (d.type as "doc" | "board" | "whiteboard") || "doc" });
  });
  ui.onAction("new-subpage", (d) => {
    if (d.id) createPage({ type: "doc", parentId: d.id });
  });
  ui.onAction("toggle-expand", (d) => {
    if (d.id) toggleExpanded(d.id);
  });
  ui.onAction("open-page", (d) => {
    // Single click previews — no tab. Double-click (panelEvents) pins.
    if (d.id) activatePage(d.id);
  });
  ui.onAction("close-tab", (d) => {
    if (d.id) closeTab(d.id);
  });
  ui.onAction("delete-page", (d) => {
    if (d.id) deletePage(d.id);
  });
  ui.onAction("fav-page", (d) => {
    if (d.id) toggleFavorite(d.id);
  });
  ui.onAction("restore-page", (d) => {
    if (d.id) restorePage(d.id);
  });
  ui.onAction("destroy-page", (d) => {
    if (d.id) destroyPage(d.id);
  });
  ui.onAction("sidebar-view", (d) => {
    store.setState({ sidebarView: d.view === "trash" || d.view === "settings" ? d.view : "pages" });
  });
  ui.onAction("set-theme", (d) => {
    store.setState({ theme: d.theme === "light" ? "light" : "dark" });
  });
  ui.onAction("toggle-palette", () => store.setState((s) => ({ paletteOpen: !s.paletteOpen })));
  ui.onAction("toggle-theme", () => store.setState((s) => ({ theme: s.theme === "dark" ? "light" : "dark" })));
  ui.onAction("toggle-animations", () => store.setState((s) => ({ editorAnimations: !s.editorAnimations })));
  ui.onAction("toggle-breadcrumb", () => store.setState((s) => ({ showBreadcrumb: !s.showBreadcrumb })));

  // ── Context-menu item actions (ctx-*) — every one dismisses the menu. ──
  ui.onAction("ctx-dismiss", () => closeCtxMenu());
  ui.onAction("ctx-open", (d) => { closeCtxMenu(); if (d.id) openPage(d.id); });
  ui.onAction("ctx-rename", (d) => {
    closeCtxMenu();
    if (d.id && store.getState().pages[d.id]) {
      store.setState({ renamingId: d.id, renamingDraft: store.getState().pages[d.id]!.title, sidebarView: "pages" });
    }
  });
  ui.onAction("ctx-fav", (d) => { closeCtxMenu(); if (d.id) toggleFavorite(d.id); });
  ui.onAction("ctx-copy-link", (d) => {
    closeCtxMenu();
    const p = d.id ? store.getState().pages[d.id] : null;
    if (p) clipboardSet(`[[${p.title || "Untitled"}]]`);
  });
  ui.onAction("ctx-new-sub", (d) => { closeCtxMenu(); if (d.id) createPage({ type: "doc", parentId: d.id }); });
  ui.onAction("ctx-dup", (d) => { closeCtxMenu(); if (d.id) duplicatePage(d.id); });
  ui.onAction("ctx-trash", (d) => { closeCtxMenu(); if (d.id) deletePage(d.id); });
  ui.onAction("ctx-restore", (d) => { closeCtxMenu(); if (d.id) restorePage(d.id); });
  ui.onAction("ctx-destroy", (d) => { closeCtxMenu(); if (d.id) destroyPage(d.id); });
  ui.onAction("ctx-close", (d) => { closeCtxMenu(); if (d.id) closeTab(d.id); });
  ui.onAction("ctx-close-others", (d) => { closeCtxMenu(); if (d.id) closeOtherTabs(d.id); });
  ui.onAction("ctx-close-all", () => { closeCtxMenu(); closeAllTabs(); });

  layout();
  return { sidebar, topbar, rerender, layout };
}

function wrap(inner: string, _id: string): string {
  return `<div class="sc-panel sc-col" style="width:100%;height:100%">${inner}</div>`;
}
