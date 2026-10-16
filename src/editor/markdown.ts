// ============================================================================
// markdown.ts — AppFlowy-style autoformatting.
//
// Block shortcuts: typing a marker + space at block start transforms the
// block kind ("- " → bullet, "# " → h1, "```" → codeblock…).
// Inline shortcuts: delimiters closed before the caret wrap the enclosed
// text into a styled span ("**bold** " → bold span).
// ============================================================================

import { blockText, type Block, type BlockKind, type Span, type TextStyle } from "./model";

export interface BlockShortcut {
  /** Marker text at offset 0 (without the trailing space). */
  marker: RegExp;
  kind: BlockKind;
  extra?: (b: Block, m: RegExpMatchArray) => void;
}

export const BLOCK_SHORTCUTS: BlockShortcut[] = [
  { marker: /^#$/, kind: "h1" },
  { marker: /^##$/, kind: "h2" },
  { marker: /^###$/, kind: "h3" },
  { marker: /^[-*•]$/, kind: "bullet" },
  { marker: /^\d+[.)]$/, kind: "number",
    extra: (b, m) => { b.num = parseInt(m[0], 10) || 1; } },
  { marker: /^>$/, kind: "quote" },
  { marker: /^(?:\[\s?\]|todo)$/i, kind: "todo" },
  { marker: /^```(\w*)$/, kind: "codeblock",
    extra: (b, m) => { b.lang = m[1] || "ts"; } },
  { marker: /^---$/, kind: "divider" },
];

/** Match a block-start shortcut against the text before the caret when the
 *  user just typed a space (space not yet inserted). Returns the new kind,
 *  how many marker chars to strip, and an optional apply fn. */
export function matchBlockShortcut(textBeforeCaret: string, kind: BlockKind):
  { kind: BlockKind; strip: number; apply?: (b: Block) => void } | null {
  if (kind === "codeblock" || kind === "divider") return null;
  for (const sc of BLOCK_SHORTCUTS) {
    const m = textBeforeCaret.match(sc.marker);
    if (m && m.index === 0 && m[0].length === textBeforeCaret.length) {
      return { kind: sc.kind, strip: m[0].length, apply: sc.extra ? (b) => sc.extra!(b, m) : undefined };
    }
  }
  return null;
}

// ── Inline markdown ─────────────────────────────────────────────────────────

const INLINE_RE = /(\*\*|__|\*|_|~~|`)([^\n]*?)\1$/;

/** If the text just before the caret ends in a closed inline pattern
 *  (e.g. "**bold**"), return its span so the caller can split spans and
 *  apply the style. Triggered after typing a space or punctuation. */
export function matchInlineShortcut(textBeforeCaret: string): { start: number; end: number; style: Partial<TextStyle> } | null {
  const m = textBeforeCaret.match(INLINE_RE);
  if (!m || m.index === undefined) return null;
  const inner = m[2]!;
  if (!inner || !inner.trim()) return null;
  const marker = m[1]!;
  const style: Partial<TextStyle> =
    marker === "**" || marker === "__" ? { weight: 700 } :
    marker === "*" || marker === "_" ? { italic: true } :
    marker === "~~" ? { strikethrough: true } :
    { code: true };
  return {
    start: m.index,
    end: m.index + m[0].length,
    style,
    // inner range = start + marker.len .. end - marker.len — caller derives
  };
}

export function inlineMarkerLen(textBeforeCaret: string): number {
  const m = textBeforeCaret.match(INLINE_RE);
  return m ? m[1]!.length : 0;
}

/** Split block.spans to apply `patch` over [start,end) of block text.
 *  Returns true if anything changed. */
export function styleRange(b: Block, start: number, end: number, patch: Partial<TextStyle>): boolean {
  if (start >= end) return false;
  const out: Span[] = [];
  let pos = 0;
  let changed = false;
  for (const sp of b.spans) {
    const s0 = pos;
    const s1 = pos + sp.text.length;
    if (s1 <= start || s0 >= end) {
      out.push(sp);
    } else {
      if (s0 < start) {
        out.push({ text: sp.text.slice(0, start - s0), style: sp.style });
      }
      const mid0 = Math.max(s0, start);
      const mid1 = Math.min(s1, end);
      out.push({ text: sp.text.slice(mid0 - s0, mid1 - s0), style: { ...sp.style, ...patch } });
      changed = true;
      if (s1 > end) {
        out.push({ text: sp.text.slice(end - s0), style: sp.style });
      }
    }
    pos = s1;
  }
  b.spans = out.filter((s) => s.text.length > 0);
  return changed;
}

/** Strip `count` utf16 units from the start of a block's spans. */
export function stripBlockPrefix(b: Block, count: number): void {
  let remaining = count;
  const out: Span[] = [];
  for (const sp of b.spans) {
    if (remaining <= 0) { out.push(sp); continue; }
    if (sp.text.length <= remaining) { remaining -= sp.text.length; continue; }
    out.push({ text: sp.text.slice(remaining), style: sp.style });
    remaining = 0;
  }
  b.spans = out;
}

export { blockText };
