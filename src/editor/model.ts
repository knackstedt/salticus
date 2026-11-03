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

/** Remove `count` utf16 units of text starting at `off` from a block's spans. */
export function spliceSpans(b: { spans: Span[] }, off: number, count: number): void {
  let pos = 0;
  let remaining = count;
  const out: Span[] = [];
  for (const sp of b.spans) {
    const s0 = pos;
    const s1 = pos + sp.text.length;
    if (remaining <= 0 || off >= s1 || off + remaining <= s0) {
      out.push(sp);
    } else {
      const keepStart = Math.max(0, off - s0);
      const delEnd = Math.min(sp.text.length, off + remaining - s0);
      const text = sp.text.slice(0, keepStart) + sp.text.slice(delEnd);
      if (text) out.push({ text, style: sp.style });
      remaining -= delEnd - keepStart;
    }
    pos = s1;
  }
  b.spans = out;
}

/** Split spans at `off`: the block keeps the head, the tail is returned. */
export function takeSpansFrom(b: { spans: Span[] }, off: number): Span[] {
  const tail: Span[] = [];
  let pos = 0;
  const keep: Span[] = [];
  for (const sp of b.spans) {
    const s1 = pos + sp.text.length;
    if (off >= s1) { keep.push(sp); }
    else if (off <= pos) { tail.push(sp); }
    else {
      keep.push({ text: sp.text.slice(0, off - pos), style: sp.style });
      tail.push({ text: sp.text.slice(off - pos), style: sp.style });
    }
    pos = s1;
  }
  b.spans = keep;
  return tail;
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
