// ============================================================================
// model.ts — block-based document model.
//
// A document is an ordered list of blocks. Each block has inline content =
// a list of styled spans. This is the unit of editing (Phase 2) and the
// unit of layout (layout.ts).
// ============================================================================

import type { Rgba } from "../text/gpu-text";
import type { FontFamily } from "../text/fonts";

export interface TextStyle {
  family: FontFamily;
  weight: number;
  italic: boolean;
  sizePx: number;
  /** Absent = theme's default text color (theme-switch safe). */
  color?: Rgba;
  /** Inline code — renders mono with a rounded bg. */
  code?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

export interface Span {
  text: string;
  style: TextStyle;
}

export type BlockKind =
  | "paragraph" | "h1" | "h2" | "h3"
  | "bullet" | "number" | "todo"
  | "quote" | "codeblock" | "divider" | "callout";

export interface Block {
  id: string;
  kind: BlockKind;
  spans: Span[];
  /** codeblock language / todo checked / number index — kind payload. */
  lang?: string;
  checked?: boolean;
  num?: number;
}

export interface Doc {
  blocks: Block[];
}

/** A position in the document: block index + utf16 offset into that block's
 *  concatenated span text. */
export interface DocPos {
  block: number;
  offset: number;
}

export function blockText(b: Block): string {
  let s = "";
  for (const sp of b.spans) s += sp.text;
  return s;
}

export function docCompare(a: DocPos, b: DocPos): number {
  if (a.block !== b.block) return a.block - b.block;
  return a.offset - b.offset;
}

let nextId = 1;
export function newBlockId(): string {
  return `b${(nextId++).toString(36)}${Date.now().toString(36).slice(-4)}`;
}

/** Default style for a block kind (base — theme colors applied by caller). */
export function blockBaseStyle(kind: BlockKind): Pick<TextStyle, "sizePx" | "weight" | "family"> {
  switch (kind) {
    case "h1": return { sizePx: 30, weight: 700, family: "inter" };
    case "h2": return { sizePx: 24, weight: 700, family: "inter" };
    case "h3": return { sizePx: 19, weight: 600, family: "inter" };
    case "quote": return { sizePx: 16, weight: 400, family: "inter" };
    case "codeblock": return { sizePx: 13, weight: 400, family: "jetbrains" };
    case "callout": return { sizePx: 15, weight: 400, family: "inter" };
    default: return { sizePx: 16, weight: 400, family: "inter" };
  }
}
