// ============================================================================
// page-controller.ts — binds view surfaces to workspace pages.
//
// Each view (doc editor, kanban, whiteboard) edits ONE content model: the
// active page's. Switching pages saves the outgoing content and loads the
// incoming one by page type. Edits mark the page dirty and a debounced
// writer flushes to pages/<id>.json.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { store } from "./store";
import { loadPageContent, savePageContent } from "./workspace";
import { requestThumb } from "./thumbnails";
import type { EditorSurface } from "../editor/surface";
import type { KanbanSurface } from "../board/surface";
import type { WhiteboardSurface } from "../wb/surface";
import { newBlockId, type Doc } from "../editor/model";
import { demoBoard, type BoardContent } from "../board/model";
import { demoWhiteboard, type WbContent } from "../wb/model";

const log = createLogger();
const SAVE_MS = 700;

export interface ViewSurfaces {
  editor: EditorSurface;
  kanban: KanbanSurface;
  whiteboard: WhiteboardSurface;
}

export function installPageController(views: ViewSurfaces): () => void {
  let currentId = store.getState().activePageId;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingDoc: Doc | null = null;
  let pendingBoard: BoardContent | null = null;
  let pendingWb: WbContent | null = null;

  const flushSave = () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!currentId) return;
    const s = store.getState();
    const p = s.pages[currentId];
    if (p?.type === "board" && pendingBoard) {
      savePageContent(currentId, { type: "board", board: pendingBoard });
      pendingBoard = null;
      store.setState({ saveIndicator: "saved" });
    } else if (p?.type === "whiteboard" && pendingWb) {
      savePageContent(currentId, { type: "whiteboard", wb: pendingWb });
      pendingWb = null;
      store.setState({ saveIndicator: "saved" });
    } else if (pendingDoc) {
      savePageContent(currentId, { type: "doc", doc: pendingDoc });
      pendingDoc = null;
      store.setState({ saveIndicator: "saved" });
    }
    requestThumb(currentId, 150);
  };

  const scheduleDocSave = () => {
    if (!currentId) return;
    pendingDoc = views.editor.document;
    store.setState({ saveIndicator: "saving" });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_MS);
  };

  const scheduleBoardSave = () => {
    if (!currentId) return;
    pendingBoard = views.kanban.getBoard();
    store.setState({ saveIndicator: "saving" });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_MS);
  };

  const scheduleWbSave = () => {
    if (!currentId) return;
    pendingWb = views.whiteboard.getContent();
    store.setState({ saveIndicator: "saving" });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_MS);
  };

  views.editor.onChange = scheduleDocSave;
  views.kanban.onChange = scheduleBoardSave;
  views.whiteboard.onChange = scheduleWbSave;

  const routeViews = () => {
    const s = store.getState();
    const p = s.activePageId ? s.pages[s.activePageId] : null;
    views.editor.setActive(!p || p.type === "doc");
    views.kanban.setActive(p?.type === "board");
    views.whiteboard.setActive(p?.type === "whiteboard");
  };

  const loadInto = (id: string | null) => {
    const s = store.getState();
    const p = id ? s.pages[id] : null;
    if (!p) {
      views.editor.setDoc({ blocks: [{ id: newBlockId(), kind: "paragraph", spans: [] }] });
      views.editor.setActive(true);
      views.kanban.setActive(false);
      views.whiteboard.setActive(false);
      return;
    }
    const c = loadPageContent(id!);
    if (p.type === "board") {
      const board = (c?.board as BoardContent | undefined) ?? demoBoard();
      views.kanban.setBoard(board);
      if (!c) scheduleBoardSave();
    } else if (p.type === "whiteboard") {
      const wb = (c?.wb as WbContent | undefined) ?? demoWhiteboard();
      views.whiteboard.setContent(wb);
      if (!c) scheduleWbSave();
    } else {
      if (c?.type === "doc" && c.doc?.blocks?.length) {
        views.editor.setDoc(c.doc);
      } else {
        views.editor.setDoc({ blocks: [{ id: newBlockId(), kind: "paragraph", spans: [] }] });
      }
    }
    routeViews();
    // Snapshot the freshly rendered page for its sidebar thumbnail.
    requestThumb(id, 1200);
  };

  // Initial load.
  loadInto(currentId);

  let switchTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSwitch: string | null | undefined;
  const unsub = store.subscribe((s) => {
    if (s.activePageId === currentId) {
      routeViews(); // page type may have changed
      return;
    }
    // Defer the flush+load off the subscriber — heavy sync work (fs IO,
    // doc swap) inside a setState notification risks reentrant churn.
    pendingSwitch = s.activePageId;
    if (switchTimer) return;
    switchTimer = setTimeout(() => {
      switchTimer = null;
      if (pendingSwitch === undefined) return;
      const next = pendingSwitch;
      pendingSwitch = undefined;
      flushSave();
      currentId = next;
      loadInto(currentId);
    }, 0);
  });

  log.info("page-controller", `installed (active=${currentId})`);

  return () => {
    flushSave();
    unsub();
  };
}
