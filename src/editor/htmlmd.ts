// ============================================================================
// htmlmd.ts — clipboard text/html → markdown.
//
// Other apps put stripped text/plain plus text/html on the OS clipboard.
// This converts the html half into the markdown interchange format, which
// clipmd's parser then turns into real blocks and styled spans — so pasting
// rich text from browsers/editors keeps bold, italic, code, underline,
// strike, headings, lists, todos, quotes, pre blocks, tables and links.
// ============================================================================

import { decodeEntities, escInline, escLineStart, wrapCode } from "./clipmd";

interface El {
  tag: string;
  attrs: Record<string, string>;
  kids: (El | string)[];
}

const VOID_TAGS = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(" "),
);

// Subtrees dropped entirely — chrome/source noise, not paste content.
const SKIP_TAGS = new Set(
  "head style script title meta link base xml noscript template iframe object select button datalist option applet svg canvas".split(" "),
);

// Optional-end-tag elements: opening `key` implicitly closes still-open
// tags in its set (clipboard html omits most optional end tags). <p> can't
// contain blocks, so any block-level open closes it; li/dt/dd/td/th/tr
// close their siblings.
const CLOSES_P = ["p"];
const AUTO_CLOSE: Record<string, string[]> = {
  p: CLOSES_P, div: CLOSES_P, section: CLOSES_P, article: CLOSES_P,
  aside: CLOSES_P, header: CLOSES_P, footer: CLOSES_P, main: CLOSES_P,
  nav: CLOSES_P, figure: CLOSES_P, figcaption: CLOSES_P, blockquote: CLOSES_P,
  pre: CLOSES_P, table: CLOSES_P, ul: CLOSES_P, ol: CLOSES_P, dl: CLOSES_P,
  form: CLOSES_P, fieldset: CLOSES_P, address: CLOSES_P, hr: CLOSES_P,
  center: CLOSES_P, details: CLOSES_P, summary: CLOSES_P, hgroup: CLOSES_P,
  menu: CLOSES_P,
  h1: CLOSES_P, h2: CLOSES_P, h3: CLOSES_P, h4: CLOSES_P, h5: CLOSES_P, h6: CLOSES_P,
  li: ["li", "p", "dt", "dd"],
  dt: ["dt", "dd", "li"],
  dd: ["dt", "dd", "li"],
  td: ["td", "th"],
  th: ["td", "th"],
  tr: ["tr", "td", "th"],
};

// Elements that force a line boundary before/after their content.
const BLOCK_TAGS = new Set(
  ("p div dl dt dd section article aside header footer main nav figure" +
    " figcaption details summary center address form fieldset legend" +
    " hgroup menu td th tr thead tbody tfoot caption body html #root").split(" "),
);

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const toks = Array.from(s.matchAll(/([\w:-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g));
  toks.forEach(m => {
    let v = m[2] ?? "";
    if (v.startsWith('"') || v.startsWith("'")) v = v.slice(1, -1);
    out[m[1]!.toLowerCase()] = decodeEntities(v);
  });
  return out;
}

/** Tiny forgiving DOM builder — clipboard fragments are usually balanced,
 *  but unclosed/mis-nested tags still have to produce sane output. */
function parseHtml(src: string): El {
  const root: El = { tag: "#root", attrs: {}, kids: [] };
  const stack: El[] = [root];
  const toks = Array.from(src.matchAll(
    /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<(?=[a-zA-Z/!?])[^>\n]*>|[^<]+|</g,
  ));
  toks.forEach(m => {
    const tok = m[0];
    if (tok.startsWith("<!--") || tok.startsWith("<![")) return;
    if (!tok.startsWith("<") || tok === "<") {
      stack[stack.length - 1]!.kids.push(tok);
      return;
    }
    const close = tok.match(/^<\/([a-zA-Z][a-zA-Z0-9:-]*)/);
    if (close) {
      const t = close[1]!.toLowerCase();
      const idx = stack.findLastIndex(e => e.tag === t);
      if (idx > 0) stack.length = idx;
      return;
    }
    if (tok.startsWith("<!") || tok.startsWith("<?")) return;
    const open = tok.match(/^<([a-zA-Z][a-zA-Z0-9:-]*)/);
    if (!open) return;
    const t = open[1]!.toLowerCase();
    const closes = AUTO_CLOSE[t];
    if (closes) {
      while (stack.length > 1 && closes.includes(stack[stack.length - 1]!.tag)) stack.pop();
    }
    const el: El = {
      tag: t,
      attrs: parseAttrs(tok.slice(open[0].length, tok.endsWith("/>") ? -2 : -1)),
      kids: [],
    };
    stack[stack.length - 1]!.kids.push(el);
    if (!VOID_TAGS.has(t) && !tok.endsWith("/>")) stack.push(el);
  });
  return root;
}

/** text/html → markdown; null when there's nothing usable. */
export function htmlToMarkdown(src: string): string | null {
  if (!/<\/?[a-zA-Z]/.test(src)) return null;
  const root = parseHtml(src);
  const lines: { t: string; structural: boolean }[] = [];
  let cur = "";
  let curStructural = false;
  let rawDepth = 0;

  const commit = () => {
    const t = cur.trim();
    if (!t) { cur = ""; curStructural = false; return; }
    // A line that is only a structural seed ("- ", "# ", "> ") keeps
    // accumulating — it belongs to the content that follows.
    if (curStructural && /^(#{1,6}|[-*+•]|\d{1,9}[.)]|- \[[ xX]\]|>+)\s*$/.test(t)) return;
    lines.push({ t, structural: curStructural });
    cur = "";
    curStructural = false;
  };

  const pushLine = (t: string, structural = true) => {
    commit();
    if (t.trim()) lines.push({ t, structural });
  };

  const emitText = (raw: string) => {
    const t = decodeEntities(raw);
    cur += rawDepth > 0 ? t.replace(/\n/g, " ") : escInline(t.replace(/\s+/g, " "));
  };

  const wrapAt = (pos: number, open: string, close: string) => {
    if (cur.length === pos) return;
    cur = cur.slice(0, pos) + open + cur.slice(pos) + close;
  };

  const verbatim = (el: El): string => {
    let out = "";
    const walk = (n: El | string) => {
      if (typeof n === "string") { out += decodeEntities(n); return; }
      if (n.tag === "br") { out += "\n"; return; }
      if (SKIP_TAGS.has(n.tag)) return;
      n.kids.forEach(walk);
    };
    el.kids.forEach(walk);
    return out;
  };

  const findLang = (el: El): string => {
    let lang = "";
    const walk = (n: El) => {
      if (lang) return;
      const cls = n.attrs["class"] ?? "";
      const m = cls.match(/(?:language|lang)-([a-zA-Z0-9_+#]+)/) ?? cls.match(/brush:\s*([a-zA-Z0-9_+#]+)/);
      if (m) { lang = m[1]!; return; }
      n.kids.forEach(k => { if (typeof k !== "string") walk(k); });
    };
    walk(el);
    return lang;
  };

  const checkboxOf = (li: El): boolean | undefined => {
    let found: boolean | undefined;
    const walk = (n: El) => {
      if (found !== undefined) return;
      if (n.tag === "input" && (n.attrs.type ?? "").toLowerCase() === "checkbox") {
        found = n.attrs.checked !== undefined || n.attrs["aria-checked"] === "true";
        return;
      }
      n.kids.forEach(k => { if (typeof k !== "string") walk(k); });
    };
    walk(li);
    return found;
  };

  const flatText = (el: El): string => {
    let out = "";
    const walk = (n: El | string) => {
      if (typeof n === "string") { out += n; return; }
      if (SKIP_TAGS.has(n.tag)) return;
      n.kids.forEach(walk);
    };
    el.kids.forEach(walk);
    return escInline(decodeEntities(out).replace(/\s+/g, " ").trim());
  };

  const collectRows = (table: El): string[][] => {
    const rows: string[][] = [];
    const cellWalk = (tr: El, cells: string[]) => {
      tr.kids.forEach(x => {
        if (typeof x === "string" || x.tag === "table") return;
        if (x.tag === "td" || x.tag === "th") cells.push(flatText(x));
        else cellWalk(x, cells);
      });
    };
    const visit = (n: El, insideNested: boolean) => {
      n.kids.forEach(k => {
        if (typeof k === "string") return;
        if (k.tag === "tr" && !insideNested) {
          const cells: string[] = [];
          cellWalk(k, cells);
          if (cells.length) rows.push(cells);
          return;
        }
        visit(k, insideNested || k.tag === "table");
      });
    };
    visit(table, false);
    return rows;
  };

  const renderLi = (li: El, marker: string) => {
    commit();
    const ck = checkboxOf(li);
    cur = ck === undefined ? marker : `- [${ck ? "x" : " "}] `;
    curStructural = true;
    li.kids.forEach(k => { if (typeof k === "string" || k.tag !== "input") render(k); });
    commit();
  };

  const marksOf = (el: El) => {
    const t = el.tag;
    const style = el.attrs.style ?? "";
    return {
      code: t === "code" || t === "kbd" || t === "samp" || t === "tt"
        || /font-family\s*:[^;}]*mono/i.test(style),
      strike: t === "s" || t === "strike" || t === "del"
        || /text-decoration(?:-line)?\s*:[^;}]*line-through/i.test(style),
      under: t === "u" || t === "ins"
        || /text-decoration(?:-line)?\s*:[^;}]*underline/i.test(style),
      bold: t === "b" || t === "strong"
        || /font-weight\s*:\s*(bold|bolder|[6-9]\d\d)/i.test(style),
      italic: t === "i" || t === "em" || t === "var" || t === "dfn" || t === "cite"
        || /font-style\s*:\s*(italic|oblique)/i.test(style),
    };
  };

  function render(node: El | string): void {
    if (typeof node === "string") { emitText(node); return; }
    const t = node.tag;
    if (SKIP_TAGS.has(t)) return;
    switch (t) {
      case "br": commit(); return;
      case "hr": pushLine("---"); return;
      case "img": {
        const srcp = (node.attrs.src ?? "").trim();
        if (srcp) cur += `![${escInline(node.attrs.alt ?? "image")}](${srcp})`;
        return;
      }
      case "input": return;
      case "a": {
        const pos = cur.length;
        node.kids.forEach(render);
        const inner = cur.slice(pos).trim();
        const href = (node.attrs.href ?? "").trim();
        if (!inner || !href || href.startsWith("#") || /^javascript:/i.test(href)) return;
        if (inner === href || inner === escInline(href)) {
          cur = cur.slice(0, pos) + `<${href}>`;
          return;
        }
        wrapAt(pos, "[", `](${href.replace(/[()\s]/g, ch => encodeURIComponent(ch))})`);
        return;
      }
      case "blockquote": {
        commit();
        const s = lines.length;
        node.kids.forEach(render);
        commit();
        for (let i = s; i < lines.length; i++) {
          lines[i]!.t = `> ${lines[i]!.t}`;
          lines[i]!.structural = true;
        }
        return;
      }
      case "pre": {
        commit();
        pushLine("```" + findLang(node));
        verbatim(node).replace(/^\n/, "").replace(/\n+$/, "").split("\n")
          .forEach(l => pushLine(l, false));
        pushLine("```");
        return;
      }
      case "table": {
        commit();
        collectRows(node).forEach(cells => pushLine(`| ${cells.join(" | ")} |`));
        return;
      }
      case "ul":
      case "ol": {
        commit();
        let n = t === "ol" ? parseInt(node.attrs.start ?? "1", 10) || 1 : 0;
        node.kids.forEach(k => {
          if (typeof k !== "string" && k.tag === "li") {
            renderLi(k, t === "ol" ? `${n++}. ` : "- ");
          } else {
            render(k);
          }
        });
        commit();
        return;
      }
      case "li": renderLi(node, "- "); return;
    }
    const h = t.match(/^h([1-6])$/);
    if (h) {
      commit();
      cur = "#".repeat(Math.min(3, parseInt(h[1]!, 10))) + " ";
      curStructural = true;
      node.kids.forEach(render);
      commit();
      return;
    }
    if (BLOCK_TAGS.has(t)) {
      commit();
      node.kids.forEach(render);
      commit();
      return;
    }
    if (rawDepth === 0) {
      const mk = marksOf(node);
      if (mk.code || mk.strike || mk.under || mk.bold || mk.italic) {
        const pos = cur.length;
        if (mk.code) {
          rawDepth++;
          node.kids.forEach(render);
          rawDepth--;
          if (cur.length > pos) cur = cur.slice(0, pos) + wrapCode(cur.slice(pos));
          return;
        }
        node.kids.forEach(render);
        if (mk.strike) wrapAt(pos, "~~", "~~");
        if (mk.under) wrapAt(pos, "<u>", "</u>");
        if (mk.bold && mk.italic) wrapAt(pos, "***", "***");
        else if (mk.bold) wrapAt(pos, "**", "**");
        else if (mk.italic) wrapAt(pos, "*", "*");
        return;
      }
    }
    node.kids.forEach(render);
  }

  render(root);
  commit();
  const md = lines
    .map(l => l.structural ? l.t : escLineStart(l.t))
    .filter(l => l.trim() !== "")
    .join("\n");
  return md || null;
}
