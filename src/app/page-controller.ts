// ============================================================================
// page-controller.ts — binds the editor surface to workspace pages.
//
// The surface edits ONE doc: the active page's. Switching pages saves the
// outgoing doc, loads the incoming one. Edits mark the page dirty and a
// debounced writer flushes {type:"doc",doc} to pages/<id>.json.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { store } from "./store";
import { loadPageContent, savePageContent } from "./workspace";
import type { EditorSurface } from "../editor/surface";
import { newBlockId, type Doc } from "../editor/model";

const log = createLogger();
const SAVE_MS = 700;

export function installPageController(surface: EditorSurface): () => void {
  let currentId = store.getState().activePageId;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pending: Doc | null = null;

  const flushSave = () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (pending !== null && currentId) {
      savePageContent(currentId, { type: "doc", doc: pending });
      pending = null;
      store.setState({ saveIndicator: "saved" });
    }
  };

  const scheduleSave = () => {
    if (!currentId) return;
    pending = surface.document;
    store.setState({ saveIndicator: "saving" });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_MS);
  };

  surface.onChange = scheduleSave;

  const loadInto = (id: string | null) => {
    if (!id) {
      surface.setDoc({ blocks: [{ id: newBlockId(), kind: "paragraph", spans: [] }] });
      return;
    }
    const c = loadPageContent(id);
    if (c?.type === "doc" && c.doc?.blocks?.length) {
      surface.setDoc(c.doc);
    } else {
      surface.setDoc({ blocks: [{ id: newBlockId(), kind: "paragraph", spans: [] }] });
    }
  };

  // Initial load.
  loadInto(currentId);

  const unsub = store.subscribe((s) => {
    if (s.activePageId === currentId) return;
    flushSave();
    currentId = s.activePageId;
    loadInto(currentId);
  });

  return () => {
    flushSave();
    unsub();
  };
}
