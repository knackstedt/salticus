// ============================================================================
// workspace.ts — JSON workspace directory: metadata + per-page content.
//
// Layout under <userData>/workspace/:
//   workspace.json       → { pages, rootOrder, openTabs, activePageId }
//   pages/<id>.json      → page content ({type:"doc",doc} | board | wb)
//
// Autosave: mutations mark dirty; a debounced writer flushes meta + the
// active page's content. Page switches save-then-load.
// ============================================================================

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveNativeUserDataDir } from "@downdraft/platform-native";
import { createLogger } from "@downdraft/engine/util/logger";
import { newId, store, type PageMeta } from "./store";
import { newBlockId, type Doc } from "../editor/model";
import { demoDoc } from "./demo-doc";

const log = createLogger();

export interface PageContent {
  type: string;
  doc?: Doc;
  board?: unknown;
  wb?: unknown;
}

let wsDir = "";
let dirtyMeta = false;
const dirtyPages = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_MS = 800;

export function workspaceDir(): string {
  if (!wsDir) {
    wsDir = join(resolveNativeUserDataDir("downdraft-graphic-notes"), "workspace");
  }
  return wsDir;
}

function metaPath(): string {
  return join(workspaceDir(), "workspace.json");
}

function pagePath(id: string): string {
  return join(workspaceDir(), "pages", `${id}.json`);
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

// ── Load ─────────────────────────────────────────────────────────────────────

/** Load workspace metadata into the store; seed a welcome page if empty. */
export function initWorkspace(): void {
  mkdirSync(join(workspaceDir(), "pages"), { recursive: true });
  let meta: { pages?: Record<string, PageMeta>; rootOrder?: string[]; openTabs?: string[]; activePageId?: string | null } = {};
  try {
    if (existsSync(metaPath())) {
      meta = JSON.parse(readFileSync(metaPath(), "utf8"));
    }
  } catch (e) {
    log.warn("workspace", `workspace.json corrupt, starting fresh: ${e}`);
  }
  const pages = meta.pages ?? {};
  const rootOrder = meta.rootOrder ?? Object.keys(pages);

  // Recover any page files not listed in metadata.
  try {
    for (const f of readdirSync(join(workspaceDir(), "pages"))) {
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -5);
      if (!pages[id]) {
        const c = loadPageContent(id);
        pages[id] = {
          id, title: "", type: (c?.type as PageMeta["type"]) ?? "doc",
          parentId: null, children: [], icon: null, favorite: false, deleted: false,
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        rootOrder.push(id);
      }
    }
  } catch { /* pages dir may not exist yet */ }

  if (Object.keys(pages).length === 0) {
    // Seed the welcome document.
    const id = newId("page");
    const meta0: PageMeta = {
      id, title: "Welcome", type: "doc", parentId: null, children: [],
      icon: null, favorite: false, deleted: false,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    pages[id] = meta0;
    rootOrder.push(id);
    savePageContent(id, { type: "doc", doc: demoDoc() });
  }

  const openTabs = (meta.openTabs ?? []).filter((t) => pages[t] && !pages[t]!.deleted);
  const active = meta.activePageId && pages[meta.activePageId] && !pages[meta.activePageId]!.deleted
    ? meta.activePageId : (openTabs[0] ?? rootOrder.find((r) => !pages[r]!.deleted) ?? null);
  store.setState({
    pages, rootOrder,
    openTabs: openTabs.length ? openTabs : (active ? [active] : []),
    activePageId: active,
  });
}

export function loadPageContent(id: string): PageContent | null {
  try {
    if (!existsSync(pagePath(id))) return null;
    return JSON.parse(readFileSync(pagePath(id), "utf8")) as PageContent;
  } catch (e) {
    log.warn("workspace", `page ${id} load failed: ${e}`);
    return null;
  }
}

// ── Save ─────────────────────────────────────────────────────────────────────

export function savePageContent(id: string, content: PageContent): void {
  try {
    mkdirSync(join(workspaceDir(), "pages"), { recursive: true });
    atomicWrite(pagePath(id), JSON.stringify(content, null, 1));
    const s = store.getState();
    const p = s.pages[id];
    if (p) store.setState({ pages: { ...s.pages, [id]: { ...p, updatedAt: Date.now() } } });
  } catch (e) {
    log.warn("workspace", `page ${id} save failed: ${e}`);
    store.setState({ saveIndicator: "error" });
  }
}

export function deletePageFile(id: string): void {
  try {
    if (existsSync(pagePath(id))) unlinkSync(pagePath(id));
  } catch { /* best-effort */ }
}

function flushMeta(): void {
  const s = store.getState();
  atomicWrite(metaPath(), JSON.stringify({
    version: 1,
    pages: s.pages,
    rootOrder: s.rootOrder,
    openTabs: s.openTabs,
    activePageId: s.activePageId,
    savedAt: Date.now(),
  }, null, 1));
  dirtyMeta = false;
}

/** Mark the active page + metadata dirty; a debounced flush writes soon. */
export function markDirty(pageId?: string): void {
  dirtyMeta = true;
  if (pageId) dirtyPages.add(pageId);
  store.setState({ saveIndicator: "saving" });
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushNow, FLUSH_MS);
}

/** Flush immediately (page switch, shutdown). */
export function flushNow(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  try {
    if (dirtyMeta) flushMeta();
    dirtyPages.clear(); // page contents are flushed by their owners
    store.setState({ saveIndicator: "saved" });
  } catch (e) {
    log.warn("workspace", `flush failed: ${e}`);
    store.setState({ saveIndicator: "error" });
  }
}

/** Subscribe: workspace metadata autosaves on relevant store changes. */
export function installAutosave(): () => void {
  let last = "";
  const unsub = store.subscribe((s) => {
    const key = JSON.stringify([s.pages, s.rootOrder, s.openTabs, s.activePageId]);
    if (key === last) return;
    last = key;
    dirtyMeta = true;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushNow, FLUSH_MS);
  });
  return unsub;
}
