// ============================================================================
// actions.ts — app-level mutations shared by UI actions, MCP tools, and the
// workspace layer. Storage wiring lands in Phase 3; these work in-memory.
// ============================================================================

import { newId, pageIcon, store, type PageMeta, type PageType } from "./store";
import { newBlockId } from "../editor/model";
import { savePageContent, deletePageFile } from "./workspace";
import { deleteThumbFile } from "./thumbnails";
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
    expanded: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const pages = { ...s.pages, [id]: meta };
  const patch: Partial<ReturnType<typeof store.getState>> = { pages };
  if (meta.parentId && pages[meta.parentId]) {
    const parent = pages[meta.parentId]!;
    pages[meta.parentId] = { ...parent, children: [...parent.children, id], expanded: true };
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

/** All descendant ids of `id` (depth-first). */
function descendants(s: ReturnType<typeof store.getState>, id: string): string[] {
  const out: string[] = [];
  const walk = (pid: string) => {
    for (const cid of s.pages[pid]?.children ?? []) {
      out.push(cid);
      walk(cid);
    }
  };
  walk(id);
  return out;
}

export function deletePage(id: string): void {
  const s = store.getState();
  const p = s.pages[id];
  if (!p) return;
  const pages = { ...s.pages, [id]: { ...p, deleted: true, updatedAt: Date.now() } };
  // Cascade the trashing to the whole subtree; descendants remember the
  // cascade root so restoring it can bring them back.
  const gone = [id];
  for (const cid of descendants(s, id)) {
    const c = pages[cid];
    if (c && !c.deleted) {
      pages[cid] = { ...c, deleted: true, deletedWith: id, updatedAt: Date.now() };
      gone.push(cid);
    }
  }
  const tabs = s.openTabs.filter((t) => !gone.includes(t));
  store.setState({
    pages,
    openTabs: tabs,
    activePageId: s.activePageId && gone.includes(s.activePageId) ? (tabs[tabs.length - 1] ?? null) : s.activePageId,
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
  const pages = { ...s.pages, [id]: { ...p, deleted: false, deletedWith: null } };
  // Bring back descendants that were trashed with this page.
  for (const cid of Object.keys(pages)) {
    const c = pages[cid]!;
    if (c.deletedWith === id) pages[cid] = { ...c, deleted: false, deletedWith: null };
  }
  store.setState({ pages });
}

export function destroyPage(id: string): void {
  const s = store.getState();
  const pages = { ...s.pages };
  const gone = [id, ...descendants(s, id)];
  // Capture the parent before deleting the page record.
  const parentId = pages[id]?.parentId;
  for (const gid of gone) delete pages[gid];
  const parent = parentId ? pages[parentId] : null;
  if (parent) pages[parent.id] = { ...parent, children: parent.children.filter((c) => c !== id) };
  store.setState({
    pages,
    rootOrder: s.rootOrder.filter((r) => !gone.includes(r)),
    openTabs: s.openTabs.filter((t) => !gone.includes(t)),
    activePageId: s.activePageId && gone.includes(s.activePageId) ? null : s.activePageId,
  });
  for (const gid of gone) {
    deletePageFile(gid);
    deleteThumbFile(gid);
  }
}

export function toggleExpanded(id: string): void {
  const s = store.getState();
  const p = s.pages[id];
  if (!p) return;
  store.setState({ pages: { ...s.pages, [id]: { ...p, expanded: !p.expanded } } });
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
