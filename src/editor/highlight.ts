// ============================================================================
// highlight.ts — lightweight syntax highlighting for code blocks.
//
// Line-local tokenizer (no cross-line block comments — a v2 can thread
// state). Produces styled sub-spans; colors follow a VS Code-ish palette
// tuned for the editor theme.
// ============================================================================

import type { Span, TextStyle } from "./model";
import type { Rgba } from "../text/gpu-text";

export interface SyntaxPalette {
  keyword: Rgba;
  string: Rgba;
  comment: Rgba;
  number: Rgba;
  type: Rgba;
  builtin: Rgba;
  operator: Rgba;
  plain: Rgba;
  property: Rgba;
}

export const darkSyntax: SyntaxPalette = {
  keyword: [0.80, 0.47, 0.85, 1],
  string: [0.62, 0.80, 0.42, 1],
  comment: [0.42, 0.48, 0.55, 1],
  number: [0.85, 0.65, 0.40, 1],
  type: [0.38, 0.78, 0.78, 1],
  builtin: [0.86, 0.84, 0.55, 1],
  operator: [0.75, 0.78, 0.85, 1],
  plain: [0.82, 0.84, 0.90, 1],
  property: [0.60, 0.76, 0.95, 1],
};

export const lightSyntax: SyntaxPalette = {
  keyword: [0.60, 0.15, 0.65, 1],
  string: [0.18, 0.50, 0.15, 1],
  comment: [0.50, 0.55, 0.60, 1],
  number: [0.70, 0.40, 0.10, 1],
  type: [0.10, 0.45, 0.55, 1],
  builtin: [0.60, 0.55, 0.10, 1],
  operator: [0.35, 0.38, 0.45, 1],
  plain: [0.16, 0.17, 0.21, 1],
  property: [0.15, 0.35, 0.75, 1],
};

const KEYWORDS: Record<string, Set<string>> = {
  ts: new Set("const let var function return if else for while do switch case default break continue new delete typeof instanceof in of class extends implements interface enum type namespace import export from as async await try catch finally throw yield static get set readonly private protected public abstract this super void null undefined true false satisfies infer keyof never unknown any".split(" ")),
  rust: new Set("fn let mut const static struct enum impl trait pub use mod crate self super Self match if else for while loop break continue return move ref as in where unsafe extern type dyn async await".split(" ")),
  py: new Set("def class return if elif else for while break continue import from as try except finally raise with lambda pass yield global nonlocal assert del is in not and or True False None async await".split(" ")),
  bash: new Set("if then else elif fi for while do done case esac function return local export echo cd source alias unset readonly shift exit eval exec".split(" ")),
  json: new Set("true false null".split(" ")),
};

const BUILTINS: Record<string, Set<string>> = {
  ts: new Set("console window document fetch Promise Map Set Array Object String Number Boolean Math JSON Date Error RegExp Symbol BigInt parseInt parseFloat isNaN".split(" ")),
  rust: new Set("println eprintln format vec String Vec Option Result Some None Ok Err Box HashMap HashSet println! dbg! assert!".split(" ")),
  py: new Set("print len range str int float list dict set tuple type isinstance enumerate zip map filter open super self cls".split(" ")),
};

function langOf(lang?: string): string {
  const l = (lang ?? "ts").toLowerCase();
  if (l === "javascript" || l === "js" || l === "jsx" || l === "tsx" || l === "typescript") return "ts";
  if (l === "python") return "py";
  if (l === "sh" || l === "shell" || l === "zsh") return "bash";
  return l in KEYWORDS ? l : "ts";
}

const TOKEN = /(\/\/[^\n]*|--[^\n]*|#[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\\n])*`)|(\b\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?\b)|(\b[A-Za-z_$][\w$]*\b)|(\n)|([^\sA-Za-z0-9_$]+)|(\s+)/g;

/** Highlight one line; returns styled spans. */
export function highlightLine(text: string, lang: string | undefined, base: TextStyle, pal: SyntaxPalette): Span[] {
  const langKey = langOf(lang);
  const kw = KEYWORDS[langKey] ?? KEYWORDS.ts!;
  const bi = BUILTINS[langKey] ?? new Set<string>();
  const spans: Span[] = [];
  const push = (t: string, color: Rgba) => {
    if (!t) return;
    const last = spans[spans.length - 1];
    if (last && last.style.color === color) last.text += t;
    else spans.push({ text: t, style: { ...base, color } });
  };

  if (!text) return spans;
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  let prevWord = false;
  while ((m = TOKEN.exec(text))) {
    const [full, comment, str, num, word, nl, punct, ws] = m;
    if (comment !== undefined) {
      if (langKey === "json" && full.startsWith("--")) push(full, pal.plain);
      else push(full, pal.comment);
    } else if (str !== undefined) {
      push(full, pal.string);
    } else if (num !== undefined) {
      push(full, pal.number);
    } else if (word !== undefined) {
      if (kw.has(full)) push(full, pal.keyword);
      else if (bi.has(full)) push(full, pal.builtin);
      else if (/^[A-Z]/.test(full) && langKey !== "bash" && langKey !== "json") push(full, pal.type);
      else if (prevWord) push(full, pal.property);
      else push(full, pal.plain);
      prevWord = false;
    } else if (nl !== undefined) {
      push(full, pal.plain);
    } else if (punct !== undefined) {
      prevWord = /[.:]$/.test(full);
      push(full, pal.operator);
    } else if (ws !== undefined) {
      push(full, pal.plain);
    }
  }
  return spans;
}
