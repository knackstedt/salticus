// ============================================================================
// clipmd.test.ts — exhaustive coverage of the markdown clipboard codec:
// serialize (every block kind + inline style + escapes), parse (block +
// inline constructs, flanking, entities, html), the paste gate, the caret
// merge, and full round-trips.
// ============================================================================

import { describe, expect, test } from "bun:test";
import {
  itemToBlock, markdownToItems, mergeBlocksAtCaret, parseInline,
  parseMarkdownBlocks, serializeBlocks, serializeInline,
  type MdItem,
} from "../../src/editor/clipmd";
import { newBlockId, type Block, type Span, type TextStyle } from "../../src/editor/model";

const T = (over: Partial<TextStyle> = {}): TextStyle => ({
  family: "inter", weight: 400, italic: false, sizePx: 16, ...over,
});
const sp = (text: string, over: Partial<TextStyle> = {}): Span => ({ text, style: T(over) });
const blk = (kind: Block["kind"], spans: Span[] | string, extra: Partial<Block> = {}): Block => ({
  id: newBlockId(), kind,
  spans: typeof spans === "string" ? (spans ? [sp(spans)] : []) : spans,
  ...extra,
});
const text = (b: Block) => b.spans.map(s => s.text).join("");
const mdSpans = (it: MdItem) => it.spans.map(s => s.text).join("");

// ── Serialize: block kinds ──────────────────────────────────────────────────

describe("serializeBlocks — block kinds", () => {
  test("paragraph", () => {
    expect(serializeBlocks([blk("paragraph", "hello")])).toBe("hello");
  });
  test("headings", () => {
    expect(serializeBlocks([blk("h1", "T")])).toBe("# T");
    expect(serializeBlocks([blk("h2", "T")])).toBe("## T");
    expect(serializeBlocks([blk("h3", "T")])).toBe("### T");
  });
  test("bullet", () => {
    expect(serializeBlocks([blk("bullet", "item")])).toBe("- item");
  });
  test("numbered", () => {
    expect(serializeBlocks([blk("number", "one", { num: 1 }), blk("number", "two", { num: 2 })]))
      .toBe("1. one\n2. two");
  });
  test("numbered picks up when num missing", () => {
    expect(serializeBlocks([blk("number", "one"), blk("number", "two")])).toBe("1. one\n2. two");
  });
  test("number sequence resets after a non-number block", () => {
    expect(serializeBlocks([
      blk("number", "one", { num: 5 }), blk("paragraph", "p"), blk("number", "x", { num: 1 }),
    ])).toBe("5. one\np\n1. x");
  });
  test("todo", () => {
    expect(serializeBlocks([blk("todo", "task", { checked: false })])).toBe("- [ ] task");
    expect(serializeBlocks([blk("todo", "done", { checked: true })])).toBe("- [x] done");
  });
  test("quote — one > line per text line", () => {
    expect(serializeBlocks([blk("quote", [sp("a\nb")])])).toBe("> a\n> b");
  });
  test("callout", () => {
    expect(serializeBlocks([blk("callout", "tip")])).toBe("> [!callout]\n> tip");
  });
  test("divider", () => {
    expect(serializeBlocks([blk("divider", "")])).toBe("---");
  });
  test("codeblock with lang", () => {
    expect(serializeBlocks([blk("codeblock", "let x = 1", { lang: "ts" })]))
      .toBe("```ts\nlet x = 1\n```");
  });
  test("codeblock without lang", () => {
    expect(serializeBlocks([blk("codeblock", "code", { lang: "" })])).toBe("```\ncode\n```");
  });
  test("codeblock containing a fence gets a longer fence", () => {
    expect(serializeBlocks([blk("codeblock", "```nested```", { lang: "" })]))
      .toBe("````\n```nested```\n````");
  });
  test("multi-block doc", () => {
    const md = serializeBlocks([
      blk("h1", "Title"),
      blk("paragraph", "body"),
      blk("bullet", "item"),
    ]);
    expect(md).toBe("# Title\nbody\n- item");
  });
});

// ── Serialize: inline marks ─────────────────────────────────────────────────

describe("serializeInline — marks", () => {
  test("plain", () => expect(serializeInline([sp("x")])).toBe("x"));
  test("bold", () => expect(serializeInline([sp("b", { weight: 700 })])).toBe("**b**"));
  test("semibold (600) is not bold", () => expect(serializeInline([sp("b", { weight: 600 })])).toBe("b"));
  test("italic", () => expect(serializeInline([sp("i", { italic: true })])).toBe("*i*"));
  test("bold+italic", () =>
    expect(serializeInline([sp("bi", { weight: 700, italic: true })])).toBe("***bi***"));
  test("underline", () => expect(serializeInline([sp("u", { underline: true })])).toBe("<u>u</u>"));
  test("strike", () => expect(serializeInline([sp("s", { strikethrough: true })])).toBe("~~s~~"));
  test("code", () => expect(serializeInline([sp("c", { code: true })])).toBe("`c`"));
  test("code containing a backtick", () =>
    expect(serializeInline([sp("a`b", { code: true })])).toBe("``a`b``"));
  test("code of only backticks", () =>
    expect(serializeInline([sp("`", { code: true })])).toBe("`` ` ``"));
  test("combo: bold + strike", () =>
    expect(serializeInline([sp("x", { weight: 700, strikethrough: true })])).toBe("**~~x~~**"));
  test("combo: underline + italic + code", () =>
    expect(serializeInline([sp("x", { underline: true, italic: true, code: true })]))
      .toBe("*<u>`x`</u>*"));
  test("adjacent spans", () =>
    expect(serializeInline([sp("a "), sp("b", { weight: 700 }), sp(" c")])).toBe("a **b** c"));
  test("marks don't span newlines", () =>
    expect(serializeInline([sp("a\nb", { weight: 700 })])).toBe("**a**\n**b**"));
});

// ── Serialize: escapes ──────────────────────────────────────────────────────

describe("serializeInline — escapes", () => {
  test("literal stars/underscores/tildes/backticks", () => {
    expect(serializeInline([sp("5*3*2")])).toBe("5\\*3\\*2");
    expect(serializeInline([sp("a_b_c")])).toBe("a\\_b\\_c");
    expect(serializeInline([sp("a~b")])).toBe("a\\~b");
    expect(serializeInline([sp("a`b")])).toBe("a\\`b");
  });
  test("literal backslash", () => expect(serializeInline([sp("a\\b")])).toBe("a\\\\b"));
  test("literal <tag>-looking text", () => expect(serializeInline([sp("a<u>b")])).toBe("a\\<u>b"));
  test("a < b untouched (no letter after <)", () =>
    expect(serializeInline([sp("a < b")])).toBe("a < b"));
  test("entity-looking & escaped", () => {
    expect(serializeInline([sp("x &amp; y")])).toBe("x &amp;amp; y");
    expect(serializeInline([sp("x & y")])).toBe("x & y");
  });
  test("image literal escaped", () =>
    expect(serializeInline([sp("![a](b)")])).toBe("\\![a](b)"));
});

describe("serializeBlocks — line-start escapes", () => {
  test.each([
    ["# not a heading", "\\# not a heading"],
    ["## deep", "\\## deep"],
    ["> not a quote", "\\> not a quote"],
    ["- not a bullet", "\\- not a bullet"],
    ["* not a bullet", "\\* not a bullet"],
    ["+ not a bullet", "\\+ not a bullet"],
    ["1. not a number", "1\\. not a number"],
    ["12) not a number", "12\\) not a number"],
    ["---", "\\---"],
    ["***", "\\*\\*\\*"],
    ["___", "\\_\\_\\_"],
    ["```", "\\`\\`\\`"],
    ["[!note] literal", "\\[!note] literal"],
    ["- [ ] not a todo", "\\- [ ] not a todo"],
  ])("paragraph %s", (src, want) => {
    expect(serializeBlocks([blk("paragraph", src)])).toBe(want);
  });
  test("marker-looking text inside a heading is still escaped", () => {
    expect(serializeBlocks([blk("h1", "# double")])).toBe("# \\# double");
  });
  test("quote content needs no escape (the > prefix shields it)", () => {
    expect(serializeBlocks([blk("quote", "- not a list")])).toBe("> - not a list");
  });
});

// ── Parse: blocks ───────────────────────────────────────────────────────────

describe("parseMarkdownBlocks — block kinds", () => {
  const kinds = (items: MdItem[]) => items.map(i => i.kind);
  test("headings, h4-6 collapse to h3", () => {
    const items = parseMarkdownBlocks("# a\n## b\n### c\n#### d\n###### e");
    expect(kinds(items)).toEqual(["h1", "h2", "h3", "h3", "h3"]);
  });
  test("heading requires space or EOL", () => {
    expect(parseMarkdownBlocks("#tag")[0]!.kind).toBe("paragraph");
    expect(parseMarkdownBlocks("#")[0]!.kind).toBe("h1");
  });
  test("bullets -, *, +, •", () => {
    const items = parseMarkdownBlocks("- a\n* b\n+ c\n• d");
    expect(kinds(items)).toEqual(["bullet", "bullet", "bullet", "bullet"]);
  });
  test("todos all markers + case", () => {
    const items = parseMarkdownBlocks("- [ ] a\n* [x] b\n+ [X] c");
    expect(items.map(i => i.checked)).toEqual([false, true, true]);
  });
  test("numbered keeps the start number", () => {
    const items = parseMarkdownBlocks("7. a\n8. b");
    expect(items.map(i => i.num)).toEqual([7, 8]);
    expect(parseMarkdownBlocks("3) x")[0]!.kind).toBe("number");
  });
  test("quote merges consecutive > lines", () => {
    const items = parseMarkdownBlocks("> a\n> b\nplain");
    expect(items.length).toBe(2);
    expect(items[0]!.kind).toBe("quote");
    expect(mdSpans(items[0]!)).toBe("a\nb");
  });
  test("callout from [!x] marker + body lines", () => {
    const items = parseMarkdownBlocks("> [!note] Title\n> body");
    expect(items.length).toBe(1);
    expect(items[0]!.kind).toBe("callout");
    expect(mdSpans(items[0]!)).toBe("Title\nbody");
  });
  test("callout with marker only", () => {
    const items = parseMarkdownBlocks("> [!callout]");
    expect(items[0]!.kind).toBe("callout");
    expect(mdSpans(items[0]!)).toBe("");
  });
  test("divider variants", () => {
    expect(parseMarkdownBlocks("---\n***\n___").map(i => i.kind))
      .toEqual(["divider", "divider", "divider"]);
  });
  test("fenced codeblock with lang", () => {
    const items = parseMarkdownBlocks("```rust\nfn main() {}\n```");
    expect(items[0]).toMatchObject({ kind: "codeblock", lang: "rust", fenced: true });
    expect(mdSpans(items[0]!)).toBe("fn main() {}");
  });
  test("unclosed fence runs to EOF", () => {
    const items = parseMarkdownBlocks("```\na\nb");
    expect(items.length).toBe(1);
    expect(mdSpans(items[0]!)).toBe("a\nb");
  });
  test("tilde fence + longer fence", () => {
    const items = parseMarkdownBlocks("~~~js\nx\n~~~\n````\n``` inside\n````");
    expect(items.map(i => i.lang)).toEqual(["js", ""]);
    expect(mdSpans(items[1]!)).toBe("``` inside");
  });
  test("tables become a codeblock", () => {
    const items = parseMarkdownBlocks("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(items[0]!.kind).toBe("codeblock");
    expect(mdSpans(items[0]!)).toContain("| a | b |");
  });
  test("blank lines are skipped, not blocks", () => {
    const items = parseMarkdownBlocks("a\n\n\nb");
    expect(kinds(items)).toEqual(["paragraph", "paragraph"]);
  });
  test("codeblock body keeps markdown chars literal", () => {
    const items = parseMarkdownBlocks("```\n# not heading\n- not list\n**not bold**\n```");
    expect(mdSpans(items[0]!)).toBe("# not heading\n- not list\n**not bold**");
  });
  test("indented markers (≤3 spaces) still parse", () => {
    const items = parseMarkdownBlocks("  - a\n   # h");
    expect(kinds(items)).toEqual(["bullet", "h1"]);
  });
});

// ── Parse: inline ───────────────────────────────────────────────────────────

describe("parseInline — marks", () => {
  const flat = (t: string) => parseInline(t).map(s => ({ t: s.text, p: s.patch }));

  test("plain text → one unstyled span", () => {
    expect(flat("hello")).toEqual([{ t: "hello", p: {} }]);
  });
  test("bold", () => {
    expect(flat("a **b** c")).toEqual([
      { t: "a ", p: {} }, { t: "b", p: { weight: 700 } }, { t: " c", p: {} },
    ]);
  });
  test("__ bold", () => {
    expect(flat("__b__")).toEqual([{ t: "b", p: { weight: 700 } }]);
  });
  test("italic", () => {
    expect(flat("*i*")).toEqual([{ t: "i", p: { italic: true } }]);
  });
  test("_ italic", () => {
    expect(flat("_i_")).toEqual([{ t: "i", p: { italic: true } }]);
  });
  test("bold+italic ***", () => {
    expect(flat("***x***")).toEqual([{ t: "x", p: { weight: 700, italic: true } }]);
  });
  test("strikethrough", () => {
    expect(flat("~~s~~")).toEqual([{ t: "s", p: { strikethrough: true } }]);
  });
  test("inline code", () => {
    expect(flat("`c`")).toEqual([{ t: "c", p: { code: true } }]);
  });
  test("code is literal inside", () => {
    expect(flat("`**not bold**`")).toEqual([{ t: "**not bold**", p: { code: true } }]);
  });
  test("double-backtick code with inner backtick", () => {
    expect(flat("`` a`b ``")).toEqual([{ t: "a`b", p: { code: true } }]);
  });
  test("underline <u>", () => {
    expect(flat("<u>x</u>")).toEqual([{ t: "x", p: { underline: true } }]);
  });
  test("html marks <b> <i> <em> <strong> <s> <del>", () => {
    expect(flat("<b>x</b>")).toEqual([{ t: "x", p: { weight: 700 } }]);
    expect(flat("<strong>x</strong>")).toEqual([{ t: "x", p: { weight: 700 } }]);
    expect(flat("<i>x</i>")).toEqual([{ t: "x", p: { italic: true } }]);
    expect(flat("<em>x</em>")).toEqual([{ t: "x", p: { italic: true } }]);
    expect(flat("<s>x</s>")).toEqual([{ t: "x", p: { strikethrough: true } }]);
    expect(flat("<del>x</del>")).toEqual([{ t: "x", p: { strikethrough: true } }]);
  });
  test("<br> becomes a space, unknown tags drop", () => {
    expect(flat("a<br>b")).toEqual([{ t: "a b", p: {} }]);
    expect(flat("a<div>x</div>b")).toEqual([{ t: "axb", p: {} }]);
  });
  test("link [t](u) → underlined text + muted url", () => {
    expect(flat("[t](http://x)")).toEqual([
      { t: "t", p: { underline: true } },
      { t: " (http://x)", p: { color: [0.55, 0.55, 0.55, 1] } },
    ]);
  });
  test("image ![a](u) → muted placeholder", () => {
    expect(flat("![alt](img.png)")).toEqual([
      { t: "[image: alt]", p: { color: [0.55, 0.55, 0.55, 1] } },
      { t: " (img.png)", p: { color: [0.55, 0.55, 0.55, 1] } },
    ]);
  });
  test("autolink <https://>", () => {
    expect(flat("<https://x.y/z>")).toEqual([{ t: "https://x.y/z", p: { underline: true } }]);
  });
  test("wiki links [[P]] stay literal", () => {
    expect(flat("see [[Page]]")).toEqual([{ t: "see [[Page]]", p: {} }]);
  });
  test("nested marks: bold containing italic", () => {
    expect(flat("**a *b* c**")).toEqual([
      { t: "a ", p: { weight: 700 } },
      { t: "b", p: { weight: 700, italic: true } },
      { t: " c", p: { weight: 700 } },
    ]);
  });
  test("nested marks: strike containing bold", () => {
    expect(flat("~~**x**~~")).toEqual([{ t: "x", p: { weight: 700, strikethrough: true } }]);
  });
  test("nested marks: underline containing bold", () => {
    expect(flat("<u>**x**</u>")).toEqual([{ t: "x", p: { weight: 700, underline: true } }]);
  });
  test("disjoint pairs both parse", () => {
    expect(flat("**a** x **b**")).toEqual([
      { t: "a", p: { weight: 700 } }, { t: " x ", p: {} }, { t: "b", p: { weight: 700 } },
    ]);
  });
});

describe("parseInline — flanking (things that must NOT parse)", () => {
  const flat = (t: string) => parseInline(t).map(s => s.text).join("");
  test("spaced delimiters stay literal", () => {
    expect(flat("* x *")).toBe("* x *");
    expect(flat("** x **")).toBe("** x **");
    expect(flat("~~ x ~~")).toBe("~~ x ~~");
    expect(flat("2 * 3 * 4")).toBe("2 * 3 * 4");
  });
  test("intraword underscores stay literal", () => {
    expect(flat("snake_case_name")).toBe("snake_case_name");
    expect(flat("a__b__c")).toBe("a__b__c");
  });
  test("unclosed marks stay literal", () => {
    expect(flat("**bold")).toBe("**bold");
    expect(flat("*ital")).toBe("*ital");
    expect(flat("`code")).toBe("`code");
    expect(flat("<u>x")).toBe("<u>x");
  });
  test("lone tilde stays literal", () => expect(flat("a~b")).toBe("a~b"));
});

describe("parseInline — escapes & entities", () => {
  const flat = (t: string) => parseInline(t).map(s => s.text).join("");
  test("escaped marks are literal", () => {
    expect(flat("\\*not italic\\*")).toBe("*not italic*");
    expect(flat("\\**not bold\\**")).toBe("*not bold*");
    expect(flat("\\`not code\\`")).toBe("`not code`");
    expect(flat("\\\\")).toBe("\\");
  });
  test("backslash before non-punct stays", () => {
    expect(flat("C:\\path\\to")).toBe("C:\\path\\to");
    expect(flat("a\\nb")).toBe("a\\nb");
  });
  test("entities decode", () => {
    expect(flat("a &amp; b")).toBe("a & b");
    expect(flat("&lt;tag&gt;")).toBe("<tag>");
    expect(flat("&quot;q&quot;")).toBe('"q"');
    expect(flat("&#65;&#x42;")).toBe("AB");
    expect(flat("&nbsp;")).toBe(" ");
  });
  test("escaped line-start markers arrive as plain paragraphs", () => {
    const items = parseMarkdownBlocks("\\# not a heading\n\\> not a quote\n\\- not a bullet\n1\\. not a number");
    expect(items.map(i => i.kind)).toEqual(["paragraph", "paragraph", "paragraph", "paragraph"]);
    expect(items.map(i => mdSpans(i))).toEqual(["# not a heading", "> not a quote", "- not a bullet", "1. not a number"]);
  });
});

// ── Gate ────────────────────────────────────────────────────────────────────

describe("markdownToItems — the markdown gate", () => {
  test("plain prose → null", () => {
    expect(markdownToItems("just a sentence")).toBeNull();
    expect(markdownToItems("line one\nline two\n\nline three")).toBeNull();
    expect(markdownToItems("")).toBeNull();
    expect(markdownToItems("   ")).toBeNull();
    expect(markdownToItems("a*b with no closer")).toBeNull();
  });
  test("block marker on first line", () => {
    expect(markdownToItems("- a")![0]!.kind).toBe("bullet");
    expect(markdownToItems("# h")![0]!.kind).toBe("h1");
    expect(markdownToItems("> q")![0]!.kind).toBe("quote");
    expect(markdownToItems("1. n")![0]!.kind).toBe("number");
    expect(markdownToItems("---")![0]!.kind).toBe("divider");
  });
  test("markers on later lines still convert", () => {
    const items = markdownToItems("intro\n- a\n- b")!;
    expect(items.map(i => i.kind)).toEqual(["paragraph", "bullet", "bullet"]);
  });
  test("single marker line mid-prose converts too", () => {
    const items = markdownToItems("intro\n- a\noutro")!;
    expect(items.map(i => i.kind)).toEqual(["paragraph", "bullet", "paragraph"]);
  });
  test("fence anywhere triggers", () => {
    const items = markdownToItems("code below\n```\nx = 1\n```")!;
    expect(items[1]!.kind).toBe("codeblock");
  });
  test("inline marks alone convert", () => {
    const items = markdownToItems("this is **bold** and *italic*")!;
    expect(items.length).toBe(1);
    expect(items[0]!.spans.map(s => s.text).join("")).toBe("this is bold and italic");
    expect(items[0]!.spans[1]!.patch).toEqual({ weight: 700 });
  });
  test("escaped-marker text converts (to a plain paragraph)", () => {
    const items = markdownToItems("\\# literal")!;
    expect(items[0]!.kind).toBe("paragraph");
    expect(mdSpans(items[0]!)).toBe("# literal");
  });
  test("entities alone convert", () => {
    expect(markdownToItems("fish &amp; chips")![0]!.spans[0]!.text).toBe("fish & chips");
  });
});

// ── Merge ───────────────────────────────────────────────────────────────────

describe("mergeBlocksAtCaret", () => {
  const doc = (kinds: [Block["kind"], string][]): Block[] =>
    kinds.map(([k, t]) => blk(k, t));

  test("into an empty paragraph, non-paragraph first item adopts its kind", () => {
    const blocks = doc([["paragraph", ""]]);
    const pos = mergeBlocksAtCaret(blocks, { block: 0, offset: 0 }, [blk("h2", "Hi")]);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.kind).toBe("h2");
    expect(text(blocks[0]!)).toBe("Hi");
    expect(pos).toEqual({ block: 0, offset: 2 });
  });
  test("paragraph item into empty typed block keeps the typed kind", () => {
    const blocks = doc([["bullet", ""]]);
    mergeBlocksAtCaret(blocks, { block: 0, offset: 0 }, [blk("paragraph", "text")]);
    expect(blocks[0]!.kind).toBe("bullet");
    expect(text(blocks[0]!)).toBe("text");
  });
  test("first item merges mid-block, splitting spans", () => {
    const blocks = doc([["paragraph", "helloworld"]]);
    mergeBlocksAtCaret(blocks, { block: 0, offset: 5 }, [blk("paragraph", [sp(" X ", { weight: 700 })])]);
    expect(text(blocks[0]!)).toBe("hello X world");
    expect(blocks[0]!.spans[1]!.style.weight).toBe(700);
  });
  test("multi-item paste: tail of caret block moves to the last pasted block", () => {
    const blocks = doc([["paragraph", "AB"]]);
    const pos = mergeBlocksAtCaret(blocks, { block: 0, offset: 1 },
      [blk("paragraph", "x"), blk("bullet", "y"), blk("quote", "z")]);
    expect(blocks.map(b => b.kind)).toEqual(["paragraph", "bullet", "quote"]);
    expect(text(blocks[0]!)).toBe("Ax");
    expect(text(blocks[2]!)).toBe("zB");
    expect(pos).toEqual({ block: 2, offset: 1 });
  });
  test("kind payloads come through", () => {
    const blocks = doc([["paragraph", ""]]);
    mergeBlocksAtCaret(blocks, { block: 0, offset: 0 }, [
      blk("todo", "t", { checked: true }), blk("number", "n", { num: 4 }), blk("codeblock", "c", { lang: "py" }),
    ]);
    expect(blocks[0]).toMatchObject({ kind: "todo", checked: true });
    expect(blocks[1]).toMatchObject({ kind: "number", num: 4 });
    expect(blocks[2]).toMatchObject({ kind: "codeblock", lang: "py" });
  });
  test("input spans are cloned, not aliased", () => {
    const blocks = doc([["paragraph", ""]]);
    const src = blk("paragraph", [sp("x", { weight: 700 })]);
    mergeBlocksAtCaret(blocks, { block: 0, offset: 0 }, [src]);
    src.spans[0]!.text = "mutated";
    src.spans[0]!.style.weight = 400;
    expect(text(blocks[0]!)).toBe("x");
    expect(blocks[0]!.spans[0]!.style.weight).toBe(700);
  });
  test("caret at end of doc", () => {
    const blocks = doc([["paragraph", "a"], ["paragraph", "b"]]);
    const pos = mergeBlocksAtCaret(blocks, { block: 1, offset: 1 }, [blk("paragraph", "c"), blk("paragraph", "d")]);
    expect(blocks.map(b => text(b))).toEqual(["a", "bc", "d"]);
    expect(pos).toEqual({ block: 2, offset: 1 });
  });
  test("pasted items get fresh ids", () => {
    const blocks = doc([["paragraph", ""]]);
    const src = blk("paragraph", "x");
    mergeBlocksAtCaret(blocks, { block: 0, offset: 0 }, [src, src]);
    expect(blocks[0]!.id).not.toBe(src.id);
    expect(blocks[1]!.id).not.toBe(src.id);
    expect(blocks[0]!.id).not.toBe(blocks[1]!.id);
  });
});

// ── itemToBlock ─────────────────────────────────────────────────────────────

describe("itemToBlock", () => {
  test("patches compose over the base style", () => {
    const b = itemToBlock({
      kind: "paragraph",
      spans: [{ text: "a", patch: {} }, { text: "b", patch: { weight: 700, code: true } }],
    }, T({ italic: true }));
    expect(b.spans[0]!.style).toMatchObject({ weight: 400, italic: true });
    expect(b.spans[1]!.style).toMatchObject({ weight: 700, italic: true, code: true });
  });
  test("kind payloads copy through", () => {
    expect(itemToBlock({ kind: "todo", checked: true, num: undefined, lang: undefined, spans: [] }, T()))
      .toMatchObject({ kind: "todo", checked: true });
  });
});

// ── Round-trip ──────────────────────────────────────────────────────────────

describe("round-trip: doc → markdown → items → blocks", () => {
  /** Compare pasted-result blocks to the source doc (style flags + text). */
  const flags = (s: Span) => ({
    t: s.text,
    b: s.style.weight >= 700,
    i: !!s.style.italic,
    u: !!s.style.underline,
    s: !!s.style.strikethrough,
    c: !!s.style.code,
  });
  const shape = (b: Block) => ({
    kind: b.kind, num: b.num, checked: b.checked, lang: b.lang,
    text: text(b),
    // Adjacent spans with identical flags are one visual run — markdown
    // can't (and shouldn't) preserve the model's exact span splitting.
    spans: b.spans.map(flags).reduce<ReturnType<typeof flags>[]>((acc, f) => {
      const prev = acc[acc.length - 1];
      if (prev && prev.b === f.b && prev.i === f.i && prev.u === f.u && prev.s === f.s && prev.c === f.c) {
        prev.t += f.t;
      } else acc.push({ ...f });
      return acc;
    }, []),
  });

  const roundTrip = (blocks: Block[]): Block[] => {
    const md = serializeBlocks(blocks);
    const items = markdownToItems(md);
    expect(items).not.toBeNull();
    return items!.map(it => itemToBlock(it, T()));
  };

  test("every block kind", () => {
    const src = [
      blk("h1", "One"), blk("h2", "Two"), blk("h3", "Three"),
      blk("paragraph", "plain"),
      blk("bullet", "b1"), blk("bullet", "b2"),
      blk("number", "n1", { num: 1 }), blk("number", "n2", { num: 2 }),
      blk("todo", "t1", { checked: true }), blk("todo", "t2", { checked: false }),
      blk("quote", "q1\nq2"),
      blk("callout", "call me"),
      blk("divider", ""),
      blk("codeblock", "let x = 1\nlet y = 2", { lang: "ts" }),
    ];
    const got = roundTrip(src).map(shape);
    const want = src.map(shape);
    // lang: the exporter drops non-word/missing langs; codeblock keeps "ts".
    want.forEach((w, i) => { if (src[i]!.kind !== "codeblock") delete w.lang; });
    expect(got).toEqual(want);
  });

  test("every inline style + combos", () => {
    const src = [blk("paragraph", [
      sp("plain "), sp("bold", { weight: 700 }), sp(" "),
      sp("ital", { italic: true }), sp(" "),
      sp("bi", { weight: 700, italic: true }), sp(" "),
      sp("und", { underline: true }), sp(" "),
      sp("strk", { strikethrough: true }), sp(" "),
      sp("code", { code: true }), sp(" "),
      sp("bu", { weight: 700, underline: true }), sp(" "),
      sp("cs", { code: true, strikethrough: true }), sp(" "),
      sp("icu", { italic: true, code: true, underline: true }),
    ])];
    const got = roundTrip(src).map(shape);
    expect(got[0]!.spans).toEqual(src.map(shape)[0]!.spans);
  });

  test("kitchen-sink doc (mirrors demoDoc)", () => {
    const src = [
      blk("h1", [sp("Salticus", { weight: 700 })]),
      blk("paragraph", [
        sp("A "), sp("GPU-native", { weight: 600 }), sp(" note-taking surface rendered with "),
        sp("custom text shaping", { italic: true }),
        sp(", a coverage atlas, and an instanced quad pipeline."),
      ]),
      blk("h2", "Why not a DOM?"),
      blk("quote", [sp("The best interface is the one that disappears", { italic: true })]),
      blk("h3", "Inline styles"),
      blk("paragraph", [
        sp("Runs can be "), sp("bold", { weight: 700 }), sp(", "), sp("italic", { italic: true }),
        sp(", "), sp("underline", { underline: true }), sp(", "), sp("strikethrough", { strikethrough: true }),
        sp(", or "), sp("code", { code: true }), sp(" — mixed freely."),
      ]),
      blk("bullet", "Nested blocks wrap at the indent"),
      blk("bullet", "Bullet markers draw as GPU quads"),
      blk("number", "Numbered items get a counter", { num: 1 }),
      blk("divider", ""),
      blk("codeblock", "fn shape(text: &str) -> Run {\n    let g = shape(face, text);\n}", { lang: "rust" }),
      blk("callout", "Tip — click anywhere to move the caret."),
    ];
    const got = roundTrip(src).map(shape);
    const want = src.map(shape);
    want.forEach(w => { delete w.lang; });
    // Rust codeblock keeps its lang through the fence.
    const rt = roundTrip(src);
    expect(rt[10]!.lang).toBe("rust");
    got.forEach(g => { delete g.lang; });
    expect(got).toEqual(want);
  });

  test("hostile literal text survives", () => {
    const src = [
      blk("paragraph", "5*3*2 and a_b_c and ~x~ and `y`"),
      blk("paragraph", "# fake heading"),
      blk("paragraph", "- fake bullet"),
      blk("paragraph", "1. fake number"),
      blk("paragraph", "> fake quote"),
      blk("paragraph", "---"),
      blk("paragraph", "```"),
      blk("paragraph", "[!note] fake callout"),
      blk("paragraph", "literal **stars** and `code`"),
      blk("paragraph", "back\\slash and &amp; entity"),
      blk("paragraph", "<u>fake underline</u>"),
    ];
    const got = roundTrip(src).map(b => text(b));
    expect(got).toEqual(src.map(b => text(b)));
  });

  test("empty + whitespace blocks", () => {
    const src = [blk("paragraph", ""), blk("paragraph", "  padded  "), blk("h1", "")];
    const got = roundTrip(src);
    expect(got.map(b => b.kind)).toEqual(["paragraph", "h1"]); // blank paragraph dropped
    expect(text(got[1]!)).toBe("");
  });
});
