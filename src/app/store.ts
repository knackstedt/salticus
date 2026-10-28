import { createStore } from "zustand/vanilla";

// ============================================================================
// Central app store (zustand vanilla — `zustand` entry imports react, which
// is not installed; vanilla is the engine-endorsed path).
// ============================================================================

export type PageType = "doc" | "board" | "whiteboard";

export interface PageMeta {
  id: string;
  title: string;
  type: PageType;
  parentId: string | null;
  /** Ordered child page ids. */
  children: string[];
  icon: string | null;
  favorite: boolean;
  deleted: boolean;
  /** Set when this page was trashed as part of an ancestor cascade — the
   *  ancestor's id. Cleared on restore. */
  deletedWith?: string | null;
  /** Tree node expanded in the sidebar (pages with children). */
  expanded: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ContentRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type SaveIndicator = "saved" | "saving" | "error";
export type ThemeName = "dark" | "light";

export interface AppState {
  running: boolean;
  /** All pages by id, including soft-deleted (deleted=true → trash). */
  pages: Record<string, PageMeta>;
  /** Ordered ids of root-level pages. */
  rootOrder: string[];
  openTabs: string[];
  activePageId: string | null;
  /** Buffer-px rect the active view surface occupies (below topbar, right of sidebar). */
  contentRect: ContentRect;
  sidebarWidth: number;
  topbarHeight: number;
  windowW: number;
  windowH: number;
  dpr: number;
  theme: ThemeName;
  /** Cosmetic editor animations (typewriter pop, flashes, pop-ins). */
  editorAnimations: boolean;
  /** Show the active page's ancestor breadcrumb in the topbar. */
  showBreadcrumb: boolean;
  saveIndicator: SaveIndicator;
  /** Monotonic counters to nudge compositors/UI to redraw. */
  docVersion: number;
  boardVersion: number;
  wbVersion: number;
  paletteOpen: boolean;
  searchOpen: boolean;
  /** Bumped when a page thumbnail file is (re)captured — nudges chrome to
   *  re-render so `<img>` picks up fresh bytes. */
  thumbVersion: number;
  /** Which pane the sidebar shows: the page tree, trash, or settings. */
  sidebarView: "pages" | "trash" | "settings";
  /** Page being renamed inline in the sidebar (context-menu "Rename"). */
  renamingId: string | null;
  /** Live draft of the sidebar rename input — kept out of the chrome
   *  re-render key so typing doesn't rebuild the input mid-edit. */
  renamingDraft: string;
  /** Per-view runtime handles, installed by view modules. */
  worldState?: () => unknown;
  /** Drop editor focus — chrome panels call this on mousedown so the caret
   *  stops blinking when the user interacts outside the document. */
  blurEditor?: () => void;
  uiState?: () => unknown;
  setTestState?: (params: Record<string, unknown>) => void | Promise<void>;
  onReady?: (ctx: unknown) => void;
  onDispose?: () => void;
}

export const store = createStore<AppState>(() => ({
  running: true,
  pages: {},
  rootOrder: [],
  openTabs: [],
  activePageId: null,
  contentRect: { x: 260, y: 46, w: 1020, h: 674 },
  sidebarWidth: 260,
  topbarHeight: 46,
  windowW: 1280,
  windowH: 720,
  dpr: 1,
  theme: "dark",
  editorAnimations: true,
  showBreadcrumb: true,
  saveIndicator: "saved",
  docVersion: 0,
  boardVersion: 0,
  wbVersion: 0,
  paletteOpen: false,
  searchOpen: false,
  thumbVersion: 0,
  sidebarView: "pages",
  renamingId: null,
  renamingDraft: "",
}));

export function pageIcon(type: PageType): string {
  return type === "doc" ? "📄" : type === "board" ? "📋" : "🎨";
}

export function bumpDoc() {
  store.setState((s) => ({ docVersion: s.docVersion + 1 }));
}
export function bumpBoard() {
  store.setState((s) => ({ boardVersion: s.boardVersion + 1 }));
}
export function bumpWb() {
  store.setState((s) => ({ wbVersion: s.wbVersion + 1 }));
}
export function bumpThumb() {
  store.setState((s) => ({ thumbVersion: s.thumbVersion + 1 }));
}

let idCounter = 0;
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(idCounter++).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
