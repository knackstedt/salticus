// ============================================================================
// clipmd.ts — markdown codec for the plain-text clipboard.
//
// The platform clipboard is plain-text only, so rich copy/paste travels as
// markdown: copy serializes the selection (block markers + inline marks,
// escaping marker-significant characters so literal text survives), paste
// parses it back into typed blocks and styled spans.
//
// Covered constructs (everything the block model can express):
//   blocks:  # h1-h3 (h4-6 → h3), -/*/• bullets, 1. numbers, - [ ] todos,
//            > quotes, > [!x] callouts, ```fenced``` code, --- dividers,
//            | tables | (→ codeblock, mono keeps the grid)
//   inline:  **bold** *italic* ***both*** __bold__ _italic_ ~~strike~~
//            `code` <u>underline</u> + <b>/<i>/<em>/<strong>/<s>/<del>
//            [text](url) ![img](url) <https://> autolinks
//            \* backslash escapes, &entity; decoding
// ============================================================================

import { blockText, newBlockId, takeSpansFrom, type Block, type BlockKind, type DocPos, type Span, type TextStyle } from "./model";

// ── Serialize ───────────────────────────────────────────────────────────────

/** Escape characters that would be reinterpreted as markdown on paste.
 *  `&` is only escaped when it already looks like an entity (so the entity
 *  survives a decode round-trip); `[`/`]` are left alone so `[[wiki]]` links
 *  stay readable. */
export function escInline(t: string): string {
  return t
    .replace(/&(?=(?:amp|lt|gt|quot|apos|nbsp|#[0-9]+|#x[0-9a-f]+);)/gi, "&amp;")
    .replace(/\\/g, "\\\\")
    .replace(/([*_~`])/g, "\\$1")
    .replace(/<(?=\/?[a-zA-Z])/g, "\\<")
    .replace(/!(?=\[[^\]\n]*\]\()/g, "\\!");
}

/** Escape a leading block-marker pattern on a content line so it reimports
 *  as literal text instead of restructuring the paste. */
export function escLineStart(line: string): string {
  return line
    .replace(/^(\s{0,3})(#{1,6})(?=\s|$)/, "$1\\$2")
    .replace(/^(\s{0,3})>/, "$1\\>")
    .replace(/^(\s{0,3})([-*+•])(?=\s|$)/, "$1\\$2")
    .replace(/^(\s{0,3})(\d{1,9})([.)])(?=\s|$)/, "$1$2\\$3")
    .replace(/^(\s{0,3})(`{3,}|~{3,})\s*$/, "$1\\$2")
    .replace(/^(\s{0,3})([-*_])(\2{2,})(\s*)$/, "$1\\$2$3$4")
    .replace(/^(\s{0,3})\[!/, "$1\\[!");
}

/** Backtick-wrap inline code — the run is one longer than any run inside. */
export function wrapCode(t: string): string {
  const runs = t.match(/`+/g) ?? [];
  const fence = "`".repeat(runs.length ? Math.max(...runs.map(r => r.length)) + 1 : 1);
  const pad = t.startsWith("`") || t.endsWith("`") || !t.trim() ? " " : "";
  return fence + pad + t + pad + fence;
}

/** Serialize one text piece (no newlines) with its inline marks. */
function wrapMarks(t: string, st: TextStyle): string {
  if (!t) return "";
  let out = st.code ? wrapCode(t) : escInline(t);
  if (st.strikethrough) out = `~~${out}~~`;
  if (st.underline) out = `<u>${out}</u>`;
  const bold = st.weight >= 700;
  if (bold && st.italic) out = `***${out}***`;
  else if (bold) out = `**${out}**`;
  else if (st.italic) out = `*${out}*`;
  return out;
}

/** Serialize inline spans to markdown (marks only, no block prefix). */
export function serializeInline(spans: Span[]): string {
  return spans.map(s =>
    s.text.split("\n").map(piece => wrapMarks(piece, s.style)).join("\n"),
  ).join("");
}

/** Serialize a within-block slice — inline marks plus line-start escapes so
 *  a fragment (e.g. literal "- text") can't turn into a block on paste. */
export function serializeFragment(spans: Span[]): string {
  return serializeInline(spans).split("\n").map(escLineStart).join("\n");
}

/** Serialize blocks to markdown — one line per block (quote/callout/codebody
 *  span text can carry embedded newlines, one output line each). */
export function serializeBlocks(blocks: Block[]): string {
  const lines: string[] = [];
  let nextNum = 1;
  for (const b of blocks) {
    // Quote/callout bodies sit behind a "> " prefix that already shields
    // their content from block-marker parsing — no line-start escapes there.
    const shielded = b.kind === "quote" || b.kind === "callout";
    const raw = serializeInline(b.spans).split("\n");
    const body = shielded
      ? raw.map(l => l.replace(/^(\s{0,3})\[!/, "$1\\[!"))
      : raw.map(escLineStart);
    switch (b.kind) {
      case "h1": case "h2": case "h3":
        lines.push(`${"#".repeat(b.kind === "h1" ? 1 : b.kind === "h2" ? 2 : 3)} ${body.join("\n")}`);
        break;
      case "bullet":
        lines.push(`- ${body.join("\n")}`);
        break;
      case "number": {
        const n = b.num ?? nextNum;
        lines.push(`${n}. ${body.join("\n")}`);
        nextNum = n + 1;
        break;
      }
      case "todo":
        lines.push(`- [${b.checked ? "x" : " "}] ${body.join("\n")}`);
        break;
      case "quote":
        body.forEach(l => lines.push(`> ${l}`));
        break;
      case "callout":
        lines.push("> [!callout]");
        body.forEach(l => lines.push(`> ${l}`));
        break;
      case "divider":
        lines.push("---");
        break;
      case "codeblock": {
        const text = blockText(b);
        const runs = text.match(/`{3,}|~{3,}/g) ?? [];
        const len = Math.max(3, ...runs.map(r => r.length + 1));
        const fence = "`".repeat(len);
        lines.push(fence + (b.lang && /^\w+$/.test(b.lang) ? b.lang : ""), ...text.split("\n"), fence);
        break;
      }
      default:
        lines.push(body.join("\n"));
        break;
    }
    if (b.kind !== "number") nextNum = 1;
  }
  return lines.join("\n");
}

// ── Parse: inline ───────────────────────────────────────────────────────────

export interface MdSpan {
  text: string;
  /** Style delta over the paste target's base style. */
  patch: Partial<TextStyle>;
}

const MUTED_PATCH: Partial<TextStyle> = { color: [0.55, 0.55, 0.55, 1] };
const ESCAPABLE = new Set([..."\\`*_{}[]()#+-.!|~<>•"]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

export function decodeEntities(t: string): string {
  return t.replace(/&(amp|lt|gt|quot|apos|nbsp);|&#(\d+);|&#x([0-9a-f]+);/gi,
    (m, named: string | undefined, dec: string | undefined, hex: string | undefined) => {
      if (named) return NAMED_ENTITIES[named.toLowerCase()] ?? m;
      try {
        return String.fromCodePoint(dec ? parseInt(dec, 10) : parseInt(hex!, 16));
      } catch {
        return m;
      }
    });
}

/** Find a backtick run identical to `run` at/after `from` — CommonMark code
 *  spans close on a run of equal length. */
function findRun(text: string, run: string, from: number): number {
  let j = from;
  for (;;) {
    j = text.indexOf("`", j);
    if (j < 0) return -1;
    const m = text.slice(j).match(/^`+/)![0];
    if (m === run) return j;
    j += m.length;
  }
}

/** Find the closing delimiter for an emphasis mark opened at `from - d.len`.
 *  A closer needs a non-space, non-escaped char before it; `_`-family closers
 *  additionally can't sit inside a word (snake_case stays literal). */
function findCloser(text: string, d: string, from: number, word: boolean): number {
  let j = from;
  for (;;) {
    j = text.indexOf(d, j);
    if (j < 0) return -1;
    const prev = text[j - 1]!;
    if (prev === "\\" || /\s/.test(prev)) { j += 1; continue; }
    if (word && /\w/.test(text[j + d.length] ?? "")) { j += 1; continue; }
    return j;
  }
}

const HTML_STYLE: Record<string, Partial<TextStyle>> = {
  b: { weight: 700 }, strong: { weight: 700 },
  i: { italic: true }, em: { italic: true },
  s: { strikethrough: true }, strike: { strikethrough: true }, del: { strikethrough: true },
  u: { underline: true },
};

/** Parse inline markdown into styled segments. Recursive: marks of different
 *  types nest (`**a ~~b~~ c**` → bold + bold-strike). Single delimiter type
 *  does not nest (the first valid closer wins). */
export function parseInline(text: string, patch: Partial<TextStyle> = {}): MdSpan[] {
  const out: MdSpan[] = [];
  let buf = "";
  const flush = () => {
    if (buf) { out.push({ text: decodeEntities(buf), patch }); buf = ""; }
  };
  const inner = (t: string, p: Partial<TextStyle>) => out.push(...parseInline(t, { ...patch, ...p }));

  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === "\\" && i + 1 < n && ESCAPABLE.has(text[i + 1]!)) {
      buf += text[i + 1]!;
      i += 2;
      continue;
    }
    if (c === "`") {
      const run = text.slice(i).match(/^`+/)![0];
      const close = findRun(text, run, i + run.length);
      if (close < 0) { buf += run; i += run.length; continue; }
      flush();
      let code = text.slice(i + run.length, close);
      // CommonMark strips one padding space pair around the content.
      if (code.length > 1 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) {
        code = code.slice(1, -1);
      }
      out.push({ text: code, patch: { ...patch, code: true } });
      i = close + run.length;
      continue;
    }
    if (c === "!" && text[i + 1] === "[") {
      const m = text.slice(i).match(/^!\[([^\]\n]*)\]\(([^)\n]*)\)/);
      if (!m) { buf += c; i++; continue; }
      flush();
      out.push({ text: `[image: ${m[1] || "image"}]`, patch: { ...patch, ...MUTED_PATCH } });
      if (m[2]) out.push({ text: ` (${m[2]})`, patch: { ...patch, ...MUTED_PATCH } });
      i += m[0].length;
      continue;
    }
    if (c === "[") {
      const m = text.slice(i).match(/^\[([^\]\n]+)\]\(([^)\n]*)\)/);
      if (!m) { buf += c; i++; continue; }
      flush();
      inner(m[1]!, { underline: true });
      if (m[2]) out.push({ text: ` (${m[2]})`, patch: { ...patch, ...MUTED_PATCH } });
      i += m[0].length;
      continue;
    }
    if (c === "<") {
      const rest = text.slice(i);
      const auto = rest.match(/^<(https?:\/\/[^>\s]+)>/i);
      if (auto) {
        flush();
        out.push({ text: auto[1]!, patch: { ...patch, underline: true } });
        i += auto[0].length;
        continue;
      }
      const tag = rest.match(/^<([a-zA-Z][a-zA-Z0-9]*)[^>\n]*>/);
      if (tag) {
        const name = tag[1]!.toLowerCase();
        const p = HTML_STYLE[name];
        if (p) {
          const close = rest.slice(tag[0].length).match(new RegExp(`</${name}\\s*>`, "i"));
          if (close && close.index !== undefined) {
            flush();
            inner(rest.slice(tag[0].length, tag[0].length + close.index), p);
            i += tag[0].length + close.index + close[0].length;
            continue;
          }
          // Unclosed style tag — keep it literal rather than eating text.
          buf += tag[0];
          i += tag[0].length;
          continue;
        }
        if (name === "br") buf += " ";
        i += tag[0].length; // other tag — drop it
        continue;
      }
      const closeTag = rest.match(/^<\/[a-zA-Z][^>\n]*>/);
      if (closeTag) { i += closeTag[0].length; continue; }
      buf += c;
      i++;
      continue;
    }
    if (c === "*" || c === "_" || (c === "~" && text[i + 1] === "~")) {
      const d = c === "~" ? "~~"
        : (text.slice(i).match(c === "*" ? /^\*+/ : /^_+/)![0]).slice(0, 3);
      const word = d[0] === "_";
      const after = text[i + d.length];
      const before = i > 0 ? text[i - 1]! : "";
      // Opener flanking: followed by non-space; `_` can't open inside a word.
      if (after !== undefined && !/\s/.test(after) && !(word && /\w/.test(before))) {
        const close = findCloser(text, d, i + d.length, word);
        if (close >= 0) {
          flush();
          const p: Partial<TextStyle> = d.length === 3 ? { weight: 700, italic: true }
            : d === "~~" ? { strikethrough: true }
            : d.length === 2 ? { weight: 700 } : { italic: true };
          inner(text.slice(i + d.length, close), p);
          i = close + d.length;
          continue;
        }
      }
      buf += d;
      i += d.length;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

// ── Parse: blocks ───────────────────────────────────────────────────────────

export interface MdItem {
  kind: BlockKind;
  spans: MdSpan[];
  checked?: boolean;
  num?: number;
  lang?: string;
  /** True when the item came from a ``` fence (vs. a table fallback). */
  fenced?: boolean;
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})(\w*)\s*$/;
const TABLE_RE = /^\s*\|.*\|\s*$/;
const CALLOUT_RE = /^\s{0,3}>\s*\[!(\w+)\]\s?(.*)$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const HEAD_RE = /^\s{0,3}(#{1,6})(?:\s+|$)(.*)$/;
const TODO_RE = /^\s{0,3}[-*+•]\s+\[([ xX])\]\s*(.*)$/;
const BULLET_RE = /^\s{0,3}[-*+•](?:\s+|$)(.*)$/;
const NUMBER_RE = /^\s{0,3}(\d{1,9})[.)](?:\s+|$)(.*)$/;
const DIVIDER_RE = /^\s{0,3}([-*_])\1{2,}\s*$/;

/** Markdown source → block items. Every nonblank line maps to exactly one
 *  item; blank lines are skipped (they're block spacing, not content). */
export function parseMarkdownBlocks(text: string): MdItem[] {
  const lines = text.split("\n");
  const items: MdItem[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = line.match(FENCE_RE);
    if (fence) {
      const ch = fence[1]![0] === "`" ? "`" : "~";
      const close = new RegExp(`^\\s{0,3}${ch === "`" ? "`" : "~"}{${fence[1]!.length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i]!)) body.push(lines[i++]!);
      i++; // consume the closer (or run off the end)
      const t = body.join("\n");
      items.push({
        kind: "codeblock", lang: fence[2] || "", fenced: true,
        spans: t ? [{ text: t, patch: {} }] : [],
      });
      continue;
    }
    if (TABLE_RE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && TABLE_RE.test(lines[i]!)) body.push(lines[i++]!);
      items.push({ kind: "codeblock", lang: "", spans: [{ text: body.join("\n"), patch: {} }] });
      continue;
    }
    const cal = line.match(CALLOUT_RE);
    if (cal) {
      const body: string[] = cal[2] ? [cal[2]] : [];
      i++;
      for (; i < lines.length;) {
        const q = lines[i]!.match(QUOTE_RE);
        if (!q || CALLOUT_RE.test(lines[i]!)) break;
        body.push(q[1]!);
        i++;
      }
      items.push({ kind: "callout", spans: parseInline(body.join("\n")) });
      continue;
    }
    const q = line.match(QUOTE_RE);
    if (q) {
      const body: string[] = [q[1]!];
      i++;
      for (; i < lines.length;) {
        const nq = lines[i]!.match(QUOTE_RE);
        if (!nq || CALLOUT_RE.test(lines[i]!)) break;
        body.push(nq[1]!);
        i++;
      }
      items.push({ kind: "quote", spans: parseInline(body.join("\n")) });
      continue;
    }
    const h = line.match(HEAD_RE);
    if (h) {
      items.push({ kind: h[1]!.length === 1 ? "h1" : h[1]!.length === 2 ? "h2" : "h3", spans: parseInline(h[2]!) });
      i++;
      continue;
    }
    const td = line.match(TODO_RE);
    if (td) {
      items.push({ kind: "todo", checked: td[1]!.toLowerCase() === "x", spans: parseInline(td[2]!) });
      i++;
      continue;
    }
    const bu = line.match(BULLET_RE);
    if (bu) {
      items.push({ kind: "bullet", spans: parseInline(bu[1]!) });
      i++;
      continue;
    }
    const nu = line.match(NUMBER_RE);
    if (nu) {
      items.push({ kind: "number", num: parseInt(nu[1]!, 10) || 1, spans: parseInline(nu[2]!) });
      i++;
      continue;
    }
    if (DIVIDER_RE.test(line)) {
      items.push({ kind: "divider", spans: [] });
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    items.push({ kind: "paragraph", spans: parseInline(line) });
    i++;
  }
  return items;
}

/** Gated parse for paste: returns items only when the text actually reads as
 *  markdown — i.e. parsing produced typed blocks, styled spans, or text that
 *  differs from verbatim lines (escapes, entities, dropped tags). Plain
 *  prose returns null so paste stays a literal text insert. */
export function markdownToItems(text: string): MdItem[] | null {
  const items = parseMarkdownBlocks(text);
  if (items.length === 0) return null;
  const verbatim = text.split("\n").filter(l => l.trim() !== "").join("\n");
  const flat = items.map(it => it.spans.map(s => s.text).join("")).join("\n");
  const changed = items.some(it => it.kind !== "paragraph" || it.spans.some(s => Object.keys(s.patch).length > 0));
  return changed || flat !== verbatim ? items : null;
}

// ── Paste merge ─────────────────────────────────────────────────────────────

/** Build a real Block from a parsed item — parsed style patches compose
 *  over the paste target's base style. */
export function itemToBlock(it: MdItem, base: TextStyle): Block {
  return {
    id: newBlockId(),
    kind: it.kind,
    checked: it.checked,
    num: it.num,
    lang: it.lang,
    spans: it.spans.filter(s => s.text).map(s => ({ text: s.text, style: { ...base, ...s.patch } })),
  };
}

/** Insert blocks at the caret: the first block merges into the caret block
 *  (adopting its kind if the caret block is empty), the rest splice in below
 *  with kinds/spans intact; the caret's old tail follows the last inserted
 *  block. Mutates `blocks`; returns the new caret position. */
export function mergeBlocksAtCaret(blocks: Block[], caret: DocPos, items: Block[]): DocPos {
  const b = blocks[caret.block];
  if (!b || items.length === 0) return caret;
  const cloneSpans = (ss: Span[]): Span[] => ss.map(s => ({ text: s.text, style: { ...s.style } }));
  const first = items[0]!;
  const firstLen = blockText(first).length;
  let pos: DocPos;
  if (first.kind !== "paragraph" && blockText(b).length === 0) {
    b.kind = first.kind;
    b.checked = first.checked;
    b.num = first.num;
    b.lang = first.lang;
    b.spans = cloneSpans(first.spans);
    pos = { block: caret.block, offset: firstLen };
  } else {
    const tail = takeSpansFrom(b, caret.offset);
    b.spans.push(...cloneSpans(first.spans), ...tail);
    pos = { block: caret.block, offset: caret.offset + firstLen };
  }
  if (items.length > 1) {
    const tail = takeSpansFrom(b, pos.offset);
    const mid: Block[] = items.slice(1).map(src => ({
      id: newBlockId(), kind: src.kind, spans: cloneSpans(src.spans),
      lang: src.lang, checked: src.checked, num: src.num,
    }));
    const last = mid[mid.length - 1]!;
    const endOff = blockText(last).length;
    last.spans.push(...tail);
    blocks.splice(caret.block + 1, 0, ...mid);
    pos = { block: caret.block + mid.length, offset: endOff };
  }
  return pos;
}
