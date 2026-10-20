// ============================================================================
// links.ts — Obsidian-style wiki-links: `[[Page Title]]`.
//
// Purely derived state — the bracketed text stays literal in the document;
// layout.ts re-styles the range and surface.ts hit-tests clicks against the
// same scan, so links light up the moment `]]` closes (and die when it is
// deleted). Targets resolve by title at click time.
// ============================================================================

export interface WikiLink {
  /** utf16 range of the whole `[[Title]]` match within the block text. */
  start: number;
  end: number;
  /** Trimmed link target (the page title between the brackets). */
  target: string;
}

const WIKI_RE = /\[\[([^\[\]\n]+)\]\]/g;

/** All wiki-links in a block's text, in document order. */
export function wikiLinks(text: string): WikiLink[] {
  const out: WikiLink[] = [];
  WIKI_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKI_RE.exec(text))) {
    const target = m[1]!.trim();
    if (!target) continue;
    out.push({ start: m.index, end: m.index + m[0].length, target });
  }
  return out;
}

/** The link whose interior contains `offset`, or null. Boundary offsets
 *  (exactly the match start/end) are excluded — they double as the caret
 *  positions adjacent to the link for editing. */
export function wikiLinkAt(text: string, offset: number): WikiLink | null {
  const links = wikiLinks(text);
  for (let i = 0; i < links.length; i++) {
    const l = links[i]!;
    if (offset > l.start && offset < l.end) return l;
    if (l.start >= offset) break;
  }
  return null;
}
