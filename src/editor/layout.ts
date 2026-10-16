// ============================================================================
// layout.ts — block → wrapped lines, positions ↔ geometry.
//
// Greedy word wrap. Runs are shaped once via the run cache; each laid-out
// line holds "segments" = (run, utf16 slice). Drawing rasterizes each
// segment substring; caret/selection math uses run clusterOffsets.
//
// Document space: y grows down, x=0 at the text origin. The surface adds
// its own origin/scroll when drawing.
// ============================================================================

import { RunCache, type RunShape } from "../text/run-cache";
import { faceKey } from "../text/fonts";
import { blockBaseStyle, blockText, type Block, type Doc, type DocPos, type TextStyle } from "./model";
import { highlightLine, type SyntaxPalette } from "./highlight";

export interface LaidSegment {
  /** Pen x of this slice within the line (doc space). */
  x: number;
  /** The run this slice belongs to. */
  run: RunShape;
  /** Full text of the run. */
  runText: string;
  /** utf16 slice of runText drawn on this line. */
  start: number;
  end: number;
  /** utf16 offset of slice start within the BLOCK's concatenated text. */
  blockOffset: number;
  style: TextStyle;
  faceKey: string;
  sizePx: number;
}

export interface LaidLine {
  /** Top of line box (doc space). */
  y: number;
  /** Line box height. */
  height: number;
  /** Baseline y (doc space). */
  baseline: number;
  segments: LaidSegment[];
  /** Block index + utf16 range of this line within the block. */
  block: number;
  blockStart: number;
  blockEnd: number;
}

export interface LaidBlock {
  block: number;
  y: number;
  height: number;
}

export interface DocLayout {
  lines: LaidLine[];
  blocks: LaidBlock[];
  height: number;
  width: number;
}

const LINE_SPACING = 1.42;   // × font size
const CODE_SPACING = 1.55;
const BLOCK_GAP = 10;        // px between blocks
const H_GAP = 8;             // extra gap around headings
const INDENT = 26;           // list/quote indent

interface Token {
  spanIdx: number;
  start: number;   // utf16 in run text
  end: number;
  blockOff: number;
  width: number;
  space: boolean;  // whitespace token
  brk?: boolean;   // forced line break (\n)
}

interface BlockRun {
  shape: RunShape | null;
  text: string;
  style: TextStyle;
  faceKey: string;
  sizePx: number;
  blockOff: number;
}

export class DocLayouter {
  constructor(private cache: RunCache) {}

  /** Wrap the whole document at `width` px (doc space). */
  layout(doc: Doc, width: number, theme: EditorTheme): DocLayout {
    const lines: LaidLine[] = [];
    const blocks: LaidBlock[] = [];
    let y = 0;

    for (let bi = 0; bi < doc.blocks.length; bi++) {
      const block = doc.blocks[bi]!;
      const blockY = y;
      const indent = (block.kind === "bullet" || block.kind === "number" ||
        block.kind === "todo" || block.kind === "quote") ? INDENT : 0;
      const avail = Math.max(40, width - indent);

      if (block.kind === "divider") {
        const h = 22;
        blocks.push({ block: bi, y, height: h });
        lines.push({ y, height: h, baseline: y + h / 2, segments: [], block: bi, blockStart: 0, blockEnd: 0 });
        y += h + BLOCK_GAP;
        continue;
      }

      const runs = this.blockRuns(block, theme);
      const lineH = lineHeightFor(block, runs);

      // Tokenize into words/space runs.
      const tokens: Token[] = [];
      for (let si = 0; si < runs.length; si++) {
        const r = runs[si]!;
        if (!r.shape) continue;
        const t = r.text;
        let i = 0;
        while (i < t.length) {
          let j = i;
          if (t[i] === "\n") {
            j++;
            tokens.push({ spanIdx: si, start: i, end: j, blockOff: r.blockOff + i, width: 0, space: true, brk: true });
            i = j;
            continue;
          }
          const space = isSpace(t[i]!);
          while (j < t.length && isSpace(t[j]!) === space && t[j] !== "\n") j++;
          tokens.push({
            spanIdx: si, start: i, end: j, blockOff: r.blockOff + i,
            width: r.shape.clusterOffsets[j]! - r.shape.clusterOffsets[i]!, space,
          });
          i = j;
        }
      }

      // Greedy line packing.
      let segs: LaidSegment[] = [];
      let segBlockStart = -1;
      let pendingSpace: Token | null = null;
      let x = indent;
      const flush = (blockEnd: number) => {
        let asc = 0;
        let desc = 0;
        for (const s of segs) { asc = Math.max(asc, s.run.ascent); desc = Math.max(desc, s.run.descent); }
        if (asc === 0) { asc = lineH * 0.75; desc = lineH * 0.25; }
        const baseline = y + lineH / 2 + (asc - desc) / 2;
        lines.push({
          y, height: lineH, baseline, segments: segs,
          block: bi, blockStart: segBlockStart < 0 ? blockEnd : segBlockStart, blockEnd,
        });
        y += lineH;
        segs = [];
        segBlockStart = -1;
        pendingSpace = null;
        x = indent;
      };
      const push = (tok: Token, start: number, end: number, width: number, blockOff: number) => {
        const r = runs[tok.spanIdx]!;
        segs.push({
          x, run: r.shape!, runText: r.text, start, end,
          blockOffset: blockOff, style: r.style, faceKey: r.faceKey, sizePx: r.sizePx,
        });
        if (segBlockStart < 0) segBlockStart = blockOff;
        x += width;
      };

      const textLen = blockText(block).length;
      for (let ti = 0; ti < tokens.length; ti++) {
        const tok = tokens[ti]!;
        if (tok.brk) {
          flush(tok.blockOff);
          continue;
        }
        if (tok.space) {
          if (segs.length > 0) pendingSpace = tok;
          continue;
        }
        if (x + tok.width > indent + avail && segs.length > 0) {
          if (tok.width <= avail) {
            flush(tok.blockOff);
          } else {
            // Word wider than a line — hard-split at cluster boundaries.
            let si = tok.start;
            while (si < tok.end) {
              const r = runs[tok.spanIdx]!;
              let ej = si;
              while (ej < tok.end) {
                const wNext = r.shape!.clusterOffsets[ej + 1]! - r.shape!.clusterOffsets[si]!;
                if (x + wNext > indent + avail) break;
                ej++;
              }
              if (ej === si) ej = si + 1; // always make progress
              const w = r.shape!.clusterOffsets[ej]! - r.shape!.clusterOffsets[si]!;
              push(tok, si, ej, w, tok.blockOff + (si - tok.start));
              si = ej;
              if (si < tok.end) flush(tok.blockOff + (si - tok.start));
            }
            continue;
          }
        }
        if (pendingSpace) {
          const w = pendingSpace.width;
          push(pendingSpace, pendingSpace.start, pendingSpace.end, w, pendingSpace.blockOff);
          pendingSpace = null;
        }
        push(tok, tok.start, tok.end, tok.width, tok.blockOff);
      }
      if (segs.length > 0) {
        flush(textLen);
      } else if (textLen === 0) {
        // Empty paragraph → one blank line.
        lines.push({
          y, height: lineH, baseline: y + lineH * 0.72, segments: [],
          block: bi, blockStart: 0, blockEnd: 0,
        });
        y += lineH;
      }

      blocks.push({ block: bi, y: blockY, height: y - blockY });
      const isHead = block.kind === "h1" || block.kind === "h2" || block.kind === "h3";
      y += isHead ? BLOCK_GAP + H_GAP : BLOCK_GAP;
    }

    return { lines, blocks, height: y, width };
  }

  private blockRuns(block: Block, theme: EditorTheme): BlockRun[] {
    const runs: BlockRun[] = [];
    let off = 0;
    for (const span of block.spans) {
      const style = resolveStyle(block, span.style, theme);
      if (block.kind === "codeblock" && span.text) {
        // Syntax-highlight: split the span into colored sub-spans. Line
        // boundaries (\n) stay as their own spans so the tokenizer sees them.
        const lines = span.text.split("\n");
        for (let li = 0; li < lines.length; li++) {
          const lineText = lines[li]!;
          const subs = highlightLine(lineText, block.lang, style, theme.syntax);
          for (const sub of subs) {
            const fk = faceKey(sub.style.family, sub.style.weight, sub.style.italic ? "italic" : "normal");
            const shape = sub.text ? this.cache.getRun(fk, sub.style.sizePx, sub.text) : null;
            runs.push({ shape, text: sub.text, style: sub.style, faceKey: fk, sizePx: sub.style.sizePx, blockOff: off });
            off += sub.text.length;
          }
          if (li < lines.length - 1) {
            const fk = faceKey(style.family, style.weight, style.italic ? "italic" : "normal");
            const shape = this.cache.getRun(fk, style.sizePx, "\n");
            runs.push({ shape, text: "\n", style, faceKey: fk, sizePx: style.sizePx, blockOff: off });
            off += 1;
          }
        }
        continue;
      }
      const fk = faceKey(style.family, style.weight, style.italic ? "italic" : "normal");
      const shape = span.text ? this.cache.getRun(fk, style.sizePx, span.text) : null;
      runs.push({ shape, text: span.text, style, faceKey: fk, sizePx: style.sizePx, blockOff: off });
      off += span.text.length;
    }
    return runs;
  }

  // ── Position ↔ geometry ──────────────────────────────────────────────────

  /** Caret rect for a document position (doc space). */
  caretRect(layout: DocLayout, pos: DocPos): { x: number; y: number; h: number } {
    const line = this.lineForPos(layout, pos);
    if (!line) return { x: 0, y: 0, h: 20 };
    return { x: this.xForPos(line, pos), y: line.y + line.height * 0.12, h: line.height * 0.76 };
  }

  /** Selection highlight rects for [a,b] (doc space): per-line quads. */
  selectionRects(layout: DocLayout, a: DocPos, b: DocPos): { x: number; y: number; w: number; h: number }[] {
    const out: { x: number; y: number; w: number; h: number }[] = [];
    if (docOrder(a, b) === 0) return out;
    for (const line of layout.lines) {
      if (line.block < a.block || line.block > b.block) continue;
      const lo = line.block === a.block ? a.offset : line.blockStart;
      const hi = line.block === b.block ? b.offset : line.blockEnd;
      if (hi <= lo) continue;
      const x0 = this.xForPos(line, { block: line.block, offset: lo });
      const x1 = this.xForPos(line, { block: line.block, offset: hi });
      out.push({ x: Math.min(x0, x1), y: line.y + line.height * 0.08, w: Math.abs(x1 - x0), h: line.height * 0.84 });
    }
    return out;
  }

  private lineForPos(layout: DocLayout, pos: DocPos): LaidLine | null {
    let last: LaidLine | null = null;
    for (const l of layout.lines) {
      if (l.block !== pos.block) continue;
      last = l;
      if (pos.offset >= l.blockStart && pos.offset <= l.blockEnd) return l;
    }
    return last;
  }

  private xForPos(line: LaidLine, pos: DocPos): number {
    for (const s of line.segments) {
      if (pos.offset < s.blockOffset || pos.offset > s.blockOffset + (s.end - s.start)) continue;
      const inner = Math.max(s.start, Math.min(s.end, pos.offset - s.blockOffset + s.start));
      const lo = s.run.clusterOffsets[s.start] ?? 0;
      const at = s.run.clusterOffsets[inner] ?? lo;
      return s.x + (at - lo);
    }
    const last = line.segments[line.segments.length - 1];
    if (last) {
      return last.x + ((last.run.clusterOffsets[last.end] ?? 0) - (last.run.clusterOffsets[last.start] ?? 0));
    }
    return 0;
  }

  /** Hit test: doc position nearest to a point (doc space). */
  posAt(layout: DocLayout, px: number, py: number): DocPos {
    if (layout.lines.length === 0) return { block: 0, offset: 0 };
    let line = layout.lines[layout.lines.length - 1]!;
    for (const l of layout.lines) {
      if (py < l.y + l.height) { line = l; break; }
    }
    const segs = line.segments;
    if (segs.length === 0) return { block: line.block, offset: line.blockStart };
    for (const s of segs) {
      const segEnd = s.x + ((s.run.clusterOffsets[s.end] ?? 0) - (s.run.clusterOffsets[s.start] ?? 0));
      if (px <= segEnd || s === segs[segs.length - 1]) {
        let best = s.start;
        let bestDist = Infinity;
        for (let i = s.start; i <= s.end; i++) {
          const x = s.x + ((s.run.clusterOffsets[i] ?? 0) - (s.run.clusterOffsets[s.start] ?? 0));
          const d = Math.abs(px - x);
          if (d < bestDist) { bestDist = d; best = i; }
        }
        return { block: line.block, offset: s.blockOffset + (best - s.start) };
      }
    }
    const last = segs[segs.length - 1]!;
    return { block: line.block, offset: last.blockOffset + (last.end - last.start) };
  }

  /** X position at line boundaries for vertical caret motion: the offset on
   *  `line` whose caret-x is closest to `goalX`. */
  offsetNearX(line: LaidLine, goalX: number): number {
    const segs = line.segments;
    if (segs.length === 0) return line.blockStart;
    let best = segs[0]!.blockOffset;
    let bestDist = Infinity;
    for (const s of segs) {
      for (let i = s.start; i <= s.end; i++) {
        const x = s.x + ((s.run.clusterOffsets[i] ?? 0) - (s.run.clusterOffsets[s.start] ?? 0));
        const d = Math.abs(goalX - x);
        if (d < bestDist) { bestDist = d; best = s.blockOffset + (i - s.start); }
      }
    }
    return best;
  }

  /** Line index containing pos (or -1). */
  lineIndexOf(layout: DocLayout, pos: DocPos): number {
    for (let i = 0; i < layout.lines.length; i++) {
      const l = layout.lines[i]!;
      if (l.block === pos.block && pos.offset >= l.blockStart && pos.offset <= l.blockEnd) return i;
    }
    for (let i = layout.lines.length - 1; i >= 0; i--) {
      if (layout.lines[i]!.block === pos.block) return i;
    }
    return -1;
  }
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n";
}

function docOrder(a: DocPos, b: DocPos): number {
  if (a.block !== b.block) return a.block - b.block;
  return a.offset - b.offset;
}

function lineHeightFor(block: Block, runs: { shape: RunShape | null; sizePx: number }[]): number {
  let max = 0;
  for (const r of runs) {
    max = Math.max(max, r.shape ? r.shape.ascent + r.shape.descent : r.sizePx);
  }
  const base = blockBaseStyle(block.kind);
  return Math.max(max, base.sizePx) * (block.kind === "codeblock" ? CODE_SPACING : LINE_SPACING);
}

function resolveStyle(block: Block, s: TextStyle, theme: EditorTheme): TextStyle {
  const base = blockBaseStyle(block.kind);
  const isCode = block.kind === "codeblock";
  return {
    family: s.code || isCode ? "jetbrains" : (s.family ?? base.family),
    weight: s.weight ?? base.weight,
    italic: s.italic ?? false,
    sizePx: s.sizePx ?? base.sizePx,
    color: s.code || isCode ? (s.color ?? theme.codeText) : (s.color ?? theme.text),
    code: s.code,
    underline: s.underline,
    strikethrough: s.strikethrough,
  };
}

export interface EditorTheme {
  text: Rgba;
  textMuted: Rgba;
  caret: Rgba;
  selection: Rgba;
  codeBg: Rgba;
  codeText: Rgba;
  quoteBar: Rgba;
  divider: Rgba;
  bulletColor: Rgba;
  syntax: SyntaxPalette;
}
