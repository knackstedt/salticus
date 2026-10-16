// ============================================================================
// history.ts — snapshot undo/redo for the document.
//
// Push a deep snapshot before each mutation; coalesce consecutive entries
// of the same kind within a window so typing doesn't flood the stack.
// ============================================================================

import type { Block, DocPos } from "./model";

export interface Snapshot {
  blocks: Block[];
  caret: DocPos;
  anchor: DocPos | null;
}

export class History {
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private lastKind = "";
  private lastTime = 0;
  private readonly LIMIT = 200;
  private readonly COALESCE_MS = 900;

  /** Call BEFORE mutating. `kind` groups coalescible edits ("type", etc). */
  push(blocks: Block[], caret: DocPos, anchor: DocPos | null, kind = "edit"): void {
    const now = Date.now();
    if (kind === this.lastKind && kind === "type" && now - this.lastTime < this.COALESCE_MS) {
      this.lastTime = now;
      return; // same typing burst — keep the older snapshot
    }
    this.lastKind = kind;
    this.lastTime = now;
    this.undoStack.push(clone(blocks, caret, anchor));
    if (this.undoStack.length > this.LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** Breaks coalescing so the next push always lands (e.g. after blur). */
  barrier(): void {
    this.lastKind = "";
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  undo(blocks: Block[], caret: DocPos, anchor: DocPos | null): Snapshot | null {
    const s = this.undoStack.pop();
    if (!s) return null;
    this.redoStack.push(clone(blocks, caret, anchor));
    this.lastKind = "";
    return s;
  }

  redo(blocks: Block[], caret: DocPos, anchor: DocPos | null): Snapshot | null {
    const s = this.redoStack.pop();
    if (!s) return null;
    this.undoStack.push(clone(blocks, caret, anchor));
    this.lastKind = "";
    return s;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.lastKind = "";
  }
}

function clone(blocks: Block[], caret: DocPos, anchor: DocPos | null): Snapshot {
  return {
    blocks: blocks.map((b) => ({
      ...b,
      spans: b.spans.map((s) => ({ ...s, style: { ...s.style } })),
    })),
    caret: { ...caret },
    anchor: anchor ? { ...anchor } : null,
  };
}
