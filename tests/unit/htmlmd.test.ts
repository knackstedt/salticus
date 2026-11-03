// ============================================================================
// htmlmd.test.ts — clipboard text/html → markdown conversion, plus the full
// html → markdown → parsed-items pipeline the paste path actually runs.
// ============================================================================

import { describe, expect, test } from "bun:test";
import { htmlToMarkdown } from "../../src/editor/htmlmd";
import { parseMarkdownBlocks, parseInline, type MdItem } from "../../src/editor/clipmd";

const md = (html: string) => htmlToMarkdown(html) ?? "<null>";
const items = (html: string): MdItem[] => parseMarkdownBlocks(md(html));
const spansText = (it: MdItem) => it.spans.map(s => s.text).join("");
const kinds = (its: MdItem[]) => its.map(i => i.kind);

// ── Inline marks ────────────────────────────────────────────────────────────

describe("htmlToMarkdown — inline marks", () => {
  test("bold", () => {
    expect(md("<p><b>bold</b></p>")).toBe("**bold**");
    expect(md("<p><strong>bold</strong></p>")).toBe("**bold**");
  });
  test("italic", () => {
    expect(md("<p><i>it</i></p>")).toBe("*it*");
    expect(md("<p><em>it</em></p>")).toBe("*it*");
  });
  test("underline", () => {
    expect(md("<p><u>u</u></p>")).toBe("<u>u</u>");
    expect(md("<p><ins>u</ins></p>")).toBe("<u>u</u>");
  });
  test("strikethrough", () => {
    expect(md("<p><s>x</s></p>")).toBe("~~x~~");
    expect(md("<p><del>x</del></p>")).toBe("~~x~~");
    expect(md("<p><strike>x</strike></p>")).toBe("~~x~~");
  });
  test("inline code", () => {
    expect(md("<p>use <code>fn()</code> here</p>")).toBe("use `fn()` here");
  });
  test("code containing a backtick widens the fence", () => {
    expect(md("<p><code>a`b</code></p>")).toBe("``a`b``");
  });
  test("nested bold+italic", () => {
    expect(md("<p><b><i>bi</i></b></p>")).toBe("***bi***");
  });
  test("bold around strike", () => {
    expect(md("<p><b>a<s>x</s>b</b></p>")).toBe("**a~~x~~b**");
  });
  test("mixed plain/styled runs keep order", () => {
    expect(md("<p>a<b>b</b>c<i>d</i>e</p>")).toBe("a**b**c*d*e");
  });
});

// ── Style attributes ────────────────────────────────────────────────────────

describe("htmlToMarkdown — style attributes", () => {
  test("font-weight 700/600 maps to bold", () => {
    expect(md('<p><span style="font-weight:700">b</span></p>')).toBe("**b**");
    expect(md('<p><span style="font-weight:600">b</span></p>')).toBe("**b**");
    expect(md('<p><span style="font-weight:bold">b</span></p>')).toBe("**b**");
  });
  test("font-weight 400 stays plain", () => {
    expect(md('<p><span style="font-weight:400">n</span></p>')).toBe("n");
  });
  test("font-style italic", () => {
    expect(md('<p><span style="font-style:italic">i</span></p>')).toBe("*i*");
  });
  test("text-decoration underline / line-through / both", () => {
    expect(md('<p><span style="text-decoration:underline">u</span></p>')).toBe("<u>u</u>");
    expect(md('<p><span style="text-decoration:line-through">s</span></p>')).toBe("~~s~~");
    expect(md('<p><span style="text-decoration:underline line-through">x</span></p>'))
      .toBe("<u>~~x~~</u>");
  });
  test("monospace font-family maps to code", () => {
    expect(md('<p><span style="font-family:monospace">m</span></p>')).toBe("`m`");
  });
});

// ── Blocks ──────────────────────────────────────────────────────────────────

describe("htmlToMarkdown — blocks", () => {
  test("headings h1–h6 (h4+ clamp to h3)", () => {
    expect(md("<h1>a</h1>")).toBe("# a");
    expect(md("<h2>a</h2>")).toBe("## a");
    expect(md("<h3>a</h3>")).toBe("### a");
    expect(md("<h5>a</h5>")).toBe("### a");
  });
  test("paragraphs and divs split into lines", () => {
    expect(md("<p>a</p><p>b</p>")).toBe("a\nb");
    expect(md("<div>a</div><div>b</div>")).toBe("a\nb");
  });
  test("heading with inline marks", () => {
    expect(md("<h2>T <b>B</b></h2>")).toBe("## T **B**");
  });
  test("br splits the line", () => {
    expect(md("<p>a<br>b</p>")).toBe("a\nb");
    expect(md("<p>a<br/>b</p>")).toBe("a\nb");
  });
  test("hr becomes a divider", () => {
    expect(md("<p>a</p><hr><p>b</p>")).toBe("a\n---\nb");
  });
  test("unordered list", () => {
    expect(md("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b");
  });
  test("ordered list preserves numbers", () => {
    expect(md("<ol><li>a</li><li>b</li></ol>")).toBe("1. a\n2. b");
  });
  test("ordered list honors start", () => {
    expect(md('<ol start="5"><li>a</li><li>b</li></ol>')).toBe("5. a\n6. b");
  });
  test("li wrapped in <p> keeps its marker", () => {
    expect(md("<ul><li><p>a</p></li><li><p>b</p></li></ul>")).toBe("- a\n- b");
  });
  test("task list items", () => {
    expect(md('<ul><li><input type="checkbox" checked>done</li><li><input type="checkbox">open</li></ul>'))
      .toBe("- [x] done\n- [ ] open");
  });
  test("blockquote lines get > prefix", () => {
    expect(md("<blockquote><p>a</p><p>b</p></blockquote>")).toBe("> a\n> b");
  });
  test("blockquote with inline marks", () => {
    expect(md("<blockquote><p>a <b>b</b></p></blockquote>")).toBe("> a **b**");
  });
  test("nested blockquote double-prefixes", () => {
    expect(md("<blockquote><blockquote><p>x</p></blockquote></blockquote>")).toBe("> > x");
  });
  test("pre → fenced code block", () => {
    expect(md("<pre>a = 1\nb = 2</pre>")).toBe("```\na = 1\nb = 2\n```");
  });
  test("pre>code language- class sets the fence language", () => {
    expect(md('<pre><code class="language-py">x = 1</code></pre>')).toBe("```py\nx = 1\n```");
  });
  test("pre keeps inner spaces verbatim", () => {
    expect(md("<pre>a   b</pre>")).toBe("```\na   b\n```");
  });
  test("table rows become pipe lines", () => {
    expect(md("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>"))
      .toBe("| a | b |\n| c | d |");
  });
});

// ── Links, images, entities ─────────────────────────────────────────────────

describe("htmlToMarkdown — links, images, entities", () => {
  test("anchor becomes markdown link", () => {
    expect(md('<p><a href="https://x.dev">text</a></p>')).toBe("[text](https://x.dev)");
  });
  test("anchor whose text is the url becomes an autolink", () => {
    expect(md('<p><a href="https://x.dev">https://x.dev</a></p>')).toBe("<https://x.dev>");
  });
  test("anchor without href unwraps", () => {
    expect(md("<p><a>text</a></p>")).toBe("text");
    expect(md('<p><a href="#frag">text</a></p>')).toBe("text");
  });
  test("image becomes ![alt](src)", () => {
    expect(md('<p><img src="https://x.dev/i.png" alt="pic"></p>')).toBe("![pic](https://x.dev/i.png)");
  });
  test("entities decode", () => {
    expect(md("<p>a &amp; b &lt;x&gt; &quot;q&quot; &#39;s&#39;</p>"))
      .toBe("a & b \\<x> \"q\" 's'");
    expect(md("<p>1&nbsp;2</p>")).toBe("1 2");
    expect(md("<p>&#65;&#x42;</p>")).toBe("AB");
  });
});

// ── Literal-marker escaping ─────────────────────────────────────────────────

describe("htmlToMarkdown — literal text escaping", () => {
  test("text asterisks/underscores escape", () => {
    expect(md("<p>2 * 3 = 6</p>")).toBe("2 \\* 3 = 6");
    expect(md("<p>snake_case_x</p>")).toBe("snake\\_case\\_x");
    expect(md("<p>a ~~ b</p>")).toBe("a \\~\\~ b");
  });
  test("line-start block markers escape", () => {
    expect(md("<p>- item</p>")).toBe("\\- item");
    expect(md("<p># tag</p>")).toBe("\\# tag");
    expect(md("<p>> quote</p>")).toBe("\\> quote");
    expect(md("<p>1. item</p>")).toBe("1\\. item");
    expect(md("<p>[!note] x</p>")).toBe("\\[!note] x");
  });
  test("mark-led line does not need line-start escaping", () => {
    expect(md("<p><b>#tag</b></p>")).toBe("**#tag**");
  });
  test("html-looking literal text escapes", () => {
    expect(md("<p>a <notreal")).toBe("a <notreal");
    expect(md("<p>a < 5 and < x</p>")).toBe("a < 5 and < x");
  });
});

// ── Noise stripping & malformed input ───────────────────────────────────────

describe("htmlToMarkdown — noise and malformed input", () => {
  test("head/style/script/meta subtrees drop", () => {
    const html = '<html><head><meta charset="utf-8"><style>p{color:red}</style></head>' +
      "<body><p>ok</p><script>alert(1)</script></body></html>";
    expect(md(html)).toBe("ok");
  });
  test("CF_HTML fragment comments strip", () => {
    expect(md("<!--StartFragment--><p><b>x</b></p><!--EndFragment-->")).toBe("**x**");
  });
  test("google-docs wrapper markup still produces content", () => {
    const html = '<meta charset="utf-8"><b style="font-weight:normal" id="docs-internal-guid-x">' +
      '<p dir="ltr"><span style="font-weight:700">Bold</span> and <span style="font-style:italic">ital</span></p></b>';
    expect(md(html)).toBe("**Bold** and *ital*");
  });
  test("unclosed bold still wraps", () => {
    expect(md("<p><b>x</p>")).toBe("**x**");
  });
  test("unclosed tag sequence tolerated", () => {
    expect(md("<ul><li>a<li>b<li>c</ul>")).toBe("- a\n- b\n- c");
  });
  test("bare text without tags returns null", () => {
    expect(htmlToMarkdown("just plain text")).toBeNull();
  });
  test("whitespace collapses like html rendering", () => {
    expect(md("<p>a   b\n   c</p>")).toBe("a b c");
  });
  test("stray inline text at top level", () => {
    expect(md("hello <b>world</b>")).toBe("hello **world**");
  });
});

// ── End-to-end: html → items ────────────────────────────────────────────────

describe("html → markdown → items pipeline", () => {
  test("browser-style fragment restores kinds and styles", () => {
    const html = `<html><body>
      <h2>Title</h2>
      <p>Normal <b>bold</b> <i>ital</i> <code>code()</code> <s>struck</s> <u>under</u></p>
      <ul><li>one</li><li>two</li></ul>
      <ol><li>first</li></ol>
      <ul><li><input type="checkbox" checked>task</li></ul>
      <blockquote><p>quoted</p></blockquote>
      <pre><code class="language-ts">let x = 1;</code></pre>
      <hr>
    </body></html>`;
    const its = items(html);
    expect(kinds(its)).toEqual(["h2", "paragraph", "bullet", "bullet", "number", "todo", "quote", "codeblock", "divider"]);
    expect(its[1]!.spans.filter(s => s.patch.weight === 700).map(s => s.text)).toEqual(["bold"]);
    expect(its[1]!.spans.filter(s => s.patch.italic).map(s => s.text)).toEqual(["ital"]);
    expect(its[1]!.spans.filter(s => s.patch.code).map(s => s.text)).toEqual(["code()"]);
    expect(its[1]!.spans.filter(s => s.patch.strikethrough).map(s => s.text)).toEqual(["struck"]);
    expect(its[1]!.spans.filter(s => s.patch.underline).map(s => s.text)).toEqual(["under"]);
    expect(its[5]!.checked).toBe(true);
    expect(its[7]!.lang).toBe("ts");
    expect(spansText(its[6]!)).toBe("quoted");
  });

  test("styled text round-trips through parseInline with exact patches", () => {
    const spans = parseInline(md("<p><b><i>x</i></b><code>y</code><u>z</u></p>"));
    expect(spans).toEqual([
      { text: "x", patch: { weight: 700, italic: true } },
      { text: "y", patch: { code: true } },
      { text: "z", patch: { underline: true } },
    ]);
  });

  test("literal markdown-looking html text stays literal", () => {
    const its = items("<p>- not a list</p><p>2 * 3 = 6</p>");
    expect(its[0]!.kind).toBe("paragraph");
    expect(spansText(its[0]!)).toBe("- not a list");
    expect(spansText(its[1]!)).toBe("2 * 3 = 6");
  });
});
