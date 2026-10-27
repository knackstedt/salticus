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
import { type Doc } from "../editor/model";
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
    wsDir = join(resolveNativeUserDataDir("downdraft-salticus"), "workspace");
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

  // Recover any page files not listed in metadata; drop orphaned atomic-write
  // temp files left behind by a killed process.
  try {
    for (const f of readdirSync(join(workspaceDir(), "pages"))) {
      if (f.endsWith(".tmp")) {
        try { unlinkSync(join(workspaceDir(), "pages", f)); } catch { /* ignore */ }
        continue;
      }
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -5);
      if (!pages[id]) {
        const c = loadPageContent(id);
        pages[id] = {
          id, title: "", type: (c?.type as PageMeta["type"]) ?? "doc",
          parentId: null, children: [], icon: null, favorite: false, deleted: false,
          expanded: true,
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        rootOrder.push(id);
      }
    }
  } catch { /* pages dir may not exist yet */ }

  // Normalize fields added after the first workspace format.
  for (const p of Object.values(pages)) {
    if (p.expanded === undefined) p.expanded = true;
  }

  if (Object.keys(pages).length === 0) {
    // Seed the welcome document.
    const id = newId("page");
    const meta0: PageMeta = {
      id, title: "Welcome", type: "doc", parentId: null, children: [],
      icon: null, favorite: false, deleted: false, expanded: true,
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
    const c = JSON.parse(readFileSync(pagePath(id), "utf8")) as PageContent;
    sanitizeDoc(c);
    return c;
  } catch (e) {
    log.warn("workspace", `page ${id} load failed: ${e}`);
    return null;
  }
}

// Stray "\r" chars were persisted by an earlier textinput bug (winit emits
// "\r" for Enter while keydown already split the block). Strip them from
// prose blocks; in codeblocks they mean a line break, so map to "\n".
// Also drop span colors that just re-state a theme's text color — those
// were baked at insert time and break theme switching.
function sanitizeDoc(c: PageContent): void {
  if (c.type !== "doc" || !c.doc?.blocks) return;
  const themeTexts = [
    [0.82, 0.84, 0.90, 1], // darkTheme().text
    [0.16, 0.17, 0.21, 1], // lightTheme().text
    [0.78, 0.82, 0.95, 1], // darkTheme().codeText
    [0.25, 0.28, 0.50, 1], // lightTheme().codeText
  ];
  for (const b of c.doc.blocks) {
    const map = b.kind === "codeblock" ? "\n" : "";
    for (const sp of b.spans) {
      if (sp.text.includes("\r")) sp.text = sp.text.replace(/\r\n?/g, map).replace(/\r/g, map);
      const col = sp.style?.color;
      if (col && themeTexts.some(t => Math.abs(t[0]! - col[0]) < 0.02 && Math.abs(t[1]! - col[1]) < 0.02 && Math.abs(t[2]! - col[2]) < 0.02)) {
        delete sp.style.color;
      }
    }
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

// ── Search ──────────────────────────────────────────────────────────────────

export interface PageHit {
  pageId: string;
  title: string;
  type: PageMeta["type"];
  /** First matching text snippet, if the hit came from content. */
  snippet: string | null;
}

function docText(doc: Doc | undefined): string {
  if (!doc) return "";
  return doc.blocks.map((b) => b.spans.map((s) => s.text).join("")).join("\n");
}

function contentText(c: PageContent): string {
  let out = docText(c.doc);
  const board = c.board as { columns?: { title: string; cards?: { title: string; desc?: string }[] }[] } | undefined;
  if (board?.columns) {
    for (const col of board.columns) {
      out += "\n" + col.title;
      for (const card of col.cards ?? []) out += "\n" + card.title + "\n" + (card.desc ?? "");
    }
  }
  const wb = c.wb as { items?: { text?: string }[] } | undefined;
  if (wb?.items) for (const it of wb.items) if (it.text) out += "\n" + it.text;
  return out;
}

/** Search page titles + content text. Non-deleted pages only. */
export function searchPages(query: string): PageHit[] {
  const q = query.trim().toLowerCase();
  const s = store.getState();
  const hits: PageHit[] = [];
  for (const p of Object.values(s.pages)) {
    if (p.deleted) continue;
    if (!q) { hits.push({ pageId: p.id, title: p.title, type: p.type, snippet: null }); continue; }
    const titleHit = (p.title || "").toLowerCase().includes(q);
    let snippet: string | null = null;
    const c = loadPageContent(p.id);
    if (c) {
      const text = contentText(c);
      const idx = text.toLowerCase().indexOf(q);
      if (idx >= 0) {
        snippet = text.slice(Math.max(0, idx - 30), idx + q.length + 50).replace(/\n+/g, " · ").trim();
      }
    }
    if (titleHit || snippet) hits.push({ pageId: p.id, title: p.title, type: p.type, snippet });
  }
  return hits;
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
