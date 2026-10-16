// ============================================================================
// board/model.ts — kanban board data model. Persisted per page as
// {type:"board", board: BoardContent}.
// ============================================================================

import { newId } from "../app/store";

export interface BoardCard {
  id: string;
  title: string;
  desc: string;
  tags: string[];
}

export interface BoardColumn {
  id: string;
  title: string;
  color: number; // palette index
  cards: BoardCard[];
}

export interface BoardContent {
  columns: BoardColumn[];
}

export function newCard(title = ""): BoardCard {
  return { id: newId("card"), title, desc: "", tags: [] };
}

export function newColumn(title: string, color: number): BoardColumn {
  return { id: newId("col"), title, color, cards: [] };
}

export function demoBoard(): BoardContent {
  return {
    columns: [
      { id: newId("col"), title: "To Do", color: 0, cards: [
        { id: newId("card"), title: "Design the glyph atlas", desc: "Shelf packing, generational eviction", tags: ["engine"] },
        { id: newId("card"), title: "Wire autosave", desc: "Debounce + atomic writes", tags: ["storage"] },
        { id: newId("card"), title: "Slash menu keyboard nav", desc: "", tags: ["editor"] },
      ] },
      { id: newId("col"), title: "In Progress", color: 1, cards: [
        { id: newId("card"), title: "Custom text pipeline", desc: "cosmic-text + harfbuzz + WGSL", tags: ["engine"] },
      ] },
      { id: newId("col"), title: "Review", color: 2, cards: [
        { id: newId("card"), title: "Markdown shortcuts", desc: "", tags: ["editor", "ux"] },
      ] },
      { id: newId("col"), title: "Done", color: 3, cards: [
        { id: newId("card"), title: "Scaffold + MCP smoke test", desc: "", tags: [] },
      ] },
    ],
  };
}
