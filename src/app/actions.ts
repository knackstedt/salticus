// ============================================================================
// actions.ts — app-level mutations shared by UI actions, MCP tools, and the
// workspace layer. Storage wiring lands in Phase 3; these work in-memory.
// ============================================================================

import { newId, pageIcon, store, type PageMeta, type PageType } from "./store";
import { newBlockId } from "../editor/model";
import { savePageContent, deletePageFile } from "./workspace";
import { newColumn, type BoardContent } from "../board/model";
import { emptyWhiteboard, type WbContent } from "../wb/model";

export function createPage(opts: { title?: string; type?: PageType; parentId?: string | null; open?: boolean } = {}): PageMeta {
  const s = store.getState();
  const id = newId("page");
  const meta: PageMeta = {
    id,
    title: opts.title ?? "",
    type: opts.type ?? "doc",
    parentId: opts.parentId ?? null,
    children: [],
    icon: null,
    favorite: false,
    deleted: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const pages = { ...s.pages, [id]: meta };
  const patch: Partial<ReturnType<typeof store.getState>> = { pages };
  if (meta.parentId && pages[meta.parentId]) {
    const parent = pages[meta.parentId]!;
    pages[meta.parentId] = { ...parent, children: [...parent.children, id] };
  } else {
    patch.rootOrder = [...s.rootOrder, id];
  }
  if (opts.open !== false) {
    patch.activePageId = id;
    patch.openTabs = s.openTabs.includes(id) ? s.openTabs : [...s.openTabs, id];
  }
  // Seed the content file BEFORE setState — the page controller's subscriber
  // reacts to activePageId immediately and must find the seeded file.
  const board: BoardContent | undefined = meta.type === "board"
    ? { columns: [newColumn("To Do", 0), newColumn("In Progress", 1), newColumn("Done", 3)] }
    : undefined;
  const wb: WbContent | undefined = meta.type === "whiteboard" ? emptyWhiteboard() : undefined;
  savePageContent(id, {
    type: meta.type,
    doc: meta.type === "doc" ? { blocks: [{ id: newBlockId(), kind: "paragraph", spans: [] }] } : undefined,
    board,
    wb,
  });
  store.setState(patch);
  return meta;
}

export function openPage(id: string): void {
  const s = store.getState();
  if (!s.pages[id]) return;
  store.setState({
    activePageId: id,
    openTabs: s.openTabs.includes(id) ? s.openTabs : [...s.openTabs, id],
  });
}

export function deletePage(id: string): void {
  const s = store.getState();
  const p = s.pages[id];
  if (!p) return;
  const pages = { ...s.pages, [id]: { ...p, deleted: true, updatedAt: Date.now() } };
  const tabs = s.openTabs.filter((t) => t !== id);
  store.setState({
    pages,
    openTabs: tabs,
    activePageId: s.activePageId === id ? (tabs[tabs.length - 1] ?? null) : s.activePageId,
  });
}

export function renamePage(id: string, title: string): void {
  const s = store.getState();
  const p = s.pages[id];
  if (!p) return;
  store.setState({ pages: { ...s.pages, [id]: { ...p, title, updatedAt: Date.now() } } });
}

export function toggleFavorite(id: string): void {
  const s = store.getState();
  const p = s.pages[id];
  if (!p) return;
  store.setState({ pages: { ...s.pages, [id]: { ...p, favorite: !p.favorite } } });
}

export function restorePage(id: string): void {
  const s = store.getState();
  const p = s.pages[id];
  if (!p?.deleted) return;
  store.setState({ pages: { ...s.pages, [id]: { ...p, deleted: false } } });
}

export function destroyPage(id: string): void {
  const s = store.getState();
  const pages = { ...s.pages };
  delete pages[id];
  store.setState({
    pages,
    rootOrder: s.rootOrder.filter((r) => r !== id),
    openTabs: s.openTabs.filter((t) => t !== id),
    activePageId: s.activePageId === id ? null : s.activePageId,
  });
  deletePageFile(id);
}

export function closeTab(id: string): void {
  const s = store.getState();
  const tabs = s.openTabs.filter((t) => t !== id);
  store.setState({
    openTabs: tabs,
    activePageId: s.activePageId === id ? (tabs[tabs.length - 1] ?? null) : s.activePageId,
  });
}

export { pageIcon };
