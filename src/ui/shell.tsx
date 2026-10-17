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
import type { HtmlUiContext, UiPanelHandle } from "@downdraft/engine/modules/html-ui";
import type { GameContext } from "@downdraft/engine/app/main";
import { createLogger } from "@downdraft/engine/util/logger";
import { store } from "../app/store";
import { closeTab, createPage, deletePage, destroyPage, openPage, restorePage, toggleExpanded, toggleFavorite } from "../app/actions";
import { serveThumbs, setThumbUi } from "../app/thumbnails";
import { chromeCss, tokens, type ThemeTokens } from "../app/theme";
import { iconBytes } from "./icons";
import { sidebarMarkup, topbarMarkup } from "./shell-markup";

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

export function mountShell(ui: HtmlUiContext, ctx: GameContext): ShellHandles {
  const s0 = store.getState();
  const W = ctx.surface.width;
  const H = ctx.surface.height;
  const sw = s0.sidebarWidth;
  const th = s0.topbarHeight;
  store.setState({
    windowW: W,
    windowH: H,
    contentRect: { x: sw, y: th, w: W - sw, h: H - th },
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
    { id: "sidebar", rect: { x: 0, y: 0, w: sw, h: H }, z: 10, scale: 2, smoothWheel: true },
  );
  const topbar = ui.mount(
    wrap(pageCss(t, fontFaces) + topbarMarkup(st), "topbar"),
    { id: "topbar", rect: { x: sw, y: 0, w: W - sw, h: th }, z: 10, scale: 2 },
  );

  function layout() {
    const s = store.getState();
    const w = s.windowW, h = s.windowH;
    sidebar.setRect({ x: 0, y: 0, w: s.sidebarWidth, h });
    topbar.setRect({ x: s.sidebarWidth, y: 0, w: w - s.sidebarWidth, h: s.topbarHeight });
    store.setState({
      contentRect: { x: s.sidebarWidth, y: s.topbarHeight, w: w - s.sidebarWidth, h: h - s.topbarHeight },
    });
  }

  function rerender() {
    const s = store.getState();
    const css = pageCss(tokens(s.theme), fontFaces);
    sidebar.setHtml(wrap(css + sidebarMarkup(s), "sidebar"));
    topbar.setHtml(wrap(css + topbarMarkup(s), "topbar"));
  }

  // Selective re-render: only when chrome-relevant state changes.
  let lastKey = "";
  const unsub = store.subscribe((s) => {
    const key = [
      s.pages, s.rootOrder, s.activePageId, s.openTabs, s.theme, s.saveIndicator,
      s.sidebarView, s.thumbVersion,
    ].map((v) => (typeof v === "object" ? JSON.stringify(v) : v)).join("|");
    if (key !== lastKey) {
      lastKey = key;
      rerender();
    }
  });
  ui.onDispose(unsub);

  ui.onResize((w, h, dpr) => {
    store.setState({ windowW: w, windowH: h, dpr });
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
    if (d.id) openPage(d.id);
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

  layout();
  return { sidebar, topbar, rerender, layout };
}

function wrap(inner: string, _id: string): string {
  return `<div class="gn-panel gn-col" style="width:100%;height:100%">${inner}</div>`;
}
