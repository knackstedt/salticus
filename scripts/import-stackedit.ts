#!/usr/bin/env bun
// ============================================================================
// import-stackedit.ts — one-shot import of a StackEdit-format notes library
// into the salticus workspace.
//
// Source layout (per directory):
//   <name>          content file (markdown / code / excalidraw JSON)
//   .<name>         hidden JSON sidecar {kind,label,order,created,modified,…}
//   <dir>/          folder (kind "directory" via its own sidecar)
//   .trash/         skipped entirely
//
// Mapping:
//   directory → doc page holding children (hierarchy preserved)
//   markdown  → doc page (headings/lists/quotes/fences; tables → codeblocks)
//   code      → doc page with a single fenced codeblock
//   canvas    → whiteboard page (excalidraw elements → WbItems; embedded
//               images → workspace/assets + "image" items)
//
// Usage:
//   bun run scripts/import-stackedit.ts [--dry-run]
//       [--src DIR]...     default: ~/Documents/StackEdit then the backup
//       [--workspace DIR]  default: ~/.config/downdraft-salticus/workspace
//
// The first --src wins on path conflicts (items present there — including in
// its .trash — suppress same-path items in later sources). Re-running replaces
// the previous import: page ids are recorded in .stackedit-import.json.
// The app only reads the workspace at boot — restart salticus afterwards.
// ============================================================================

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import sharp from "sharp";

import { newId } from "../src/app/store";
import { newBlockId, type Block, type BlockKind, type Doc, type Span, type TextStyle } from "../src/editor/model";
import { normalizeWbItem, type WbArrowhead, type WbContent, type WbFont, type WbItem } from "../src/wb/model";

// ── args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const argList = (flag: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === flag) out.push(argv[i + 1]!);
  return out;
};
const SRCS = (argList("--src").length ? argList("--src") : [
  join(homedir(), "Documents", "StackEdit"),
  join(homedir(), "Documents", "stackedit.backup.10.7.2025"),
]).map(s => s.replace(/\/+$/, ""));
const WS = (argList("--workspace")[0]) ?? join(homedir(), ".config", "downdraft-salticus", "workspace");
const MARKER = join(WS, ".stackedit-import.json");

// ── source scan ─────────────────────────────────────────────────────────────

interface Sidecar {
  kind?: string;
  label?: string;
  filename?: string;
  order?: number;
  icon?: string;
  created?: number;
  modified?: number;
  deleted?: number;
  originalPath?: string;
  expanded?: boolean;
}

interface Item {
  /** Path segments from the library root, leaf included. */
  rel: string[];
  kind: "directory" | "markdown" | "code" | "canvas";
  title: string;
  order: number;
  created?: number;
  modified?: number;
  /** Absolute content path ("" for directories). */
  file: string;
}

const STRIP_EXT = /\.(md|markdown|txt|canvas|code|ts|tsx|js|jsx|py|sql|sh|bash|json|ya?ml|html?|css|rs|go|java|c|h|cpp|cs|rb|lua|excalidraw)$/i;

function readSidecar(p: string): Sidecar | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Sidecar;
  } catch {
    return null;
  }
}

function kindFor(file: string, sc: Sidecar | null): Item["kind"] {
  const k = sc?.kind;
  if (k === "markdown" || k === "code" || k === "canvas") return k;
  if (k === "directory") return "directory";
  // No/unknown sidecar — sniff content + extension.
  const ext = file.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? "";
  if (ext === "canvas" || ext === "excalidraw") return "canvas";
  try {
    const head = readFileSync(file, { encoding: "utf8", flag: "r" }).slice(0, 200);
    if (head.startsWith('{"elements"')) return "canvas";
  } catch { /* binary/unreadable → treat as code */ }
  if (["ts", "tsx", "js", "jsx", "py", "sql", "sh", "bash", "json", "yaml", "yml",
    "html", "css", "rs", "go", "java", "c", "h", "cpp", "cs", "rb", "lua", "code"].includes(ext)) return "code";
  return "markdown";
}

function titleFor(file: string, sc: Sidecar | null): string {
  const name = (sc?.label && !sc.label.startsWith(".")) ? sc.label : (sc?.filename ?? basename(file));
  return name.replace(STRIP_EXT, "") || name;
}

/** Scan one library root. Returns items (trash excluded) + the rel-paths of
 *  every item present anywhere in the tree (for cross-source suppression). */
function scanLibrary(root: string): { items: Item[]; present: Set<string>; trashed: Set<string> } {
  const items: Item[] = [];
  const present = new Set<string>();
  const trashed = new Set<string>();

  const walk = (abs: string, rel: string[]): void => {
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    const sidecars = new Map<string, Sidecar | null>();
    for (const e of entries) {
      if (!e.startsWith(".")) continue;
      const p = join(abs, e);
      try {
        if (statSync(p).isFile()) sidecars.set(e.slice(1), readSidecar(p));
      } catch { /* ignore */ }
    }
    for (const e of entries) {
      if (e.startsWith(".")) {
        if (e === ".trash") {
          // Record original locations so later sources don't resurrect them.
          const tdir = join(abs, e);
          const tParent = rel.join("/");
          for (const t of readdirSync(tdir)) {
            if (!t.startsWith(".")) continue;
            const sc = readSidecar(join(tdir, t));
            const orig = (sc?.originalPath ?? "/").replace(/^\/+|\/+$/g, "");
            const name = sc?.filename ?? t.slice(1);
            const key = [orig, name].filter(Boolean).join("/");
            trashed.add(key);
            if (tParent) trashed.add(`${tParent}/${key}`);
          }
          continue;
        }
        continue;
      }
      const p = join(abs, e);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      const relHere = [...rel, e];
      present.add(relHere.join("/"));
      const sc = sidecars.get(e) ?? null;
      if (st.isDirectory()) {
        items.push({
          rel: relHere, kind: "directory", title: titleFor(e, sc),
          order: sc?.order ?? Number.MAX_SAFE_INTEGER,
          created: sc?.created, modified: sc?.modified, file: "",
        });
        walk(p, relHere);
        continue;
      }
      if (sc?.deleted) continue;
      items.push({
        rel: relHere, kind: kindFor(p, sc), title: titleFor(p, sc),
        order: sc?.order ?? Number.MAX_SAFE_INTEGER,
        created: sc?.created, modified: sc?.modified, file: p,
      });
    }
  };
  walk(root, []);
  return { items, present, trashed };
}

// ── markdown → doc ──────────────────────────────────────────────────────────

const BASE: TextStyle = { family: "inter", weight: 400, italic: false, sizePx: 16 };
const MUTED: TextStyle = { ...BASE, color: [0.55, 0.55, 0.55, 1] };

const INLINE_RE = /(!?\[[^\]]*\]\([^)\n]*\)|\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|~~[^~\n]+~~|`[^`\n]+`|<\/?[a-zA-Z][^>\n]*>)/g;

/** Inline markdown → styled spans (single level — no nesting). */
function spans(text: string): Span[] {
  const out: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const i = m.index!;
    if (i > last) out.push({ text: text.slice(last, i), style: { ...BASE } });
    const tok = m[0];
    if (tok.startsWith("![")) {
      const mm = tok.match(/!\[([^\]]*)\]\(([^)\n]*)\)/)!;
      out.push({ text: `[image: ${mm[1] || "image"}]`, style: { ...MUTED } });
      if (mm[2]) out.push({ text: ` (${mm[2]})`, style: { ...MUTED } });
    } else if (tok.startsWith("[")) {
      const mm = tok.match(/\[([^\]]*)\]\(([^)\n]*)\)/)!;
      out.push({ text: mm[1]!, style: { ...BASE, underline: true } });
      if (mm[2]) out.push({ text: ` (${mm[2]})`, style: { ...MUTED } });
    } else if (tok.startsWith("***")) {
      out.push({ text: tok.slice(3, -3), style: { ...BASE, weight: 700, italic: true } });
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      out.push({ text: tok.slice(2, -2), style: { ...BASE, weight: 700 } });
    } else if (tok.startsWith("*") || tok.startsWith("_")) {
      out.push({ text: tok.slice(1, -1), style: { ...BASE, italic: true } });
    } else if (tok.startsWith("~~")) {
      out.push({ text: tok.slice(2, -2), style: { ...BASE, strikethrough: true } });
    } else if (tok.startsWith("`")) {
      out.push({ text: tok.slice(1, -1), style: { ...BASE, code: true } });
    }
    // html tags drop
    last = i + tok.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), style: { ...BASE } });
  return out.length ? out : [{ text: "", style: { ...BASE } }];
}

function block(kind: BlockKind, text: string, extra: Partial<Block> = {}): Block {
  return { id: newBlockId(), kind, spans: kind === "codeblock" ? [{ text, style: { ...BASE } }] : spans(text), ...extra };
}

/** Markdown source → editor Doc. Tables become codeblocks (mono keeps the
 *  grid); constructs the block model can't express degrade to text. */
export function mdToDoc(md: string): Doc {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  // YAML frontmatter.
  let i = 0;
  if (lines[0]?.trim() === "---") {
    for (let j = 1; j < lines.length; j++) {
      if (lines[j]!.trim() === "---") { i = j + 1; break; }
    }
  }
  for (; i < lines.length;) {
    const line = lines[i]!;
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      for (; i < lines.length && !/^\s*```\s*$/.test(lines[i]!);) body.push(lines[i++]!);
      i++;
      blocks.push(block("codeblock", body.join("\n"), { lang: fence[1] || "" }));
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!);) body.push(lines[i++]!);
      blocks.push(block("codeblock", body.join("\n"), { lang: "" }));
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/))) {
      const lv = Math.min(3, m[1]!.length);
      blocks.push(block(lv === 1 ? "h1" : lv === 2 ? "h2" : "h3", m[2]!));
    } else if ((m = line.match(/^\s*>\s?(.*)$/))) {
      // Consecutive ">" lines form one blockquote — a single quote block
      // with embedded newlines.
      const body = [m[1]!];
      for (; i + 1 < lines.length;) {
        const nm = lines[i + 1]!.match(/^\s*>\s?(.*)$/);
        if (!nm) break;
        body.push(nm[1]!);
        i++;
      }
      blocks.push(block("quote", body.join("\n")));
    } else if ((m = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/))) {
      blocks.push(block("todo", m[2]!, { checked: m[1]!.toLowerCase() === "x" }));
    } else if ((m = line.match(/^\s*[-*+•]\s+(.*)$/))) {
      blocks.push(block("bullet", m[1]!));
    } else if ((m = line.match(/^\s*(\d{1,9})[.)]\s+(.*)$/))) {
      blocks.push(block("number", m[2]!, { num: parseInt(m[1]!, 10) || 1 }));
    } else if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(block("divider", ""));
    } else if (!line.trim()) {
      // skip — block spacing already separates content
    } else {
      blocks.push(block("paragraph", line));
    }
    i++;
  }
  if (!blocks.length) blocks.push(block("paragraph", ""));
  return { blocks };
}

// ── code → doc ──────────────────────────────────────────────────────────────

const EXT_LANG: Record<string, string> = {
  ts: "ts", tsx: "ts", js: "js", jsx: "js", py: "py", sql: "sql", surrealql: "sql",
  sh: "bash", bash: "bash", json: "json", yaml: "yaml", yml: "yaml",
  html: "html", htm: "html", css: "css", rs: "rust", go: "go", java: "java",
  c: "c", h: "c", cpp: "cpp", cs: "cs", rb: "rb", lua: "lua", code: "",
};

function langFor(file: string, body: string): string {
  const ext = file.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (ext && ext in EXT_LANG) return EXT_LANG[ext]!;
  const head = body.slice(0, 200);
  if (/^#!.*\b(ba|z|fi)?sh\b/.test(head)) return "bash";
  if (/\b(import|export)\b.{0,40}\bfrom\b/.test(head)) return "ts";
  if (/^\s*(LET|SELECT|CREATE|DEFINE)\b/i.test(head)) return "sql";
  if (/^\s*[<{[]/.test(head)) return "json";
  return "";
}

function codeToDoc(file: string): Doc {
  const body = readFileSync(file, "utf8");
  return { blocks: [{ id: newBlockId(), kind: "codeblock", spans: [{ text: body.replace(/\r\n?/g, "\n"), style: { ...BASE } }], lang: langFor(file, body) }] };
}

// ── excalidraw → whiteboard ─────────────────────────────────────────────────

// Duplicated from src/wb/draw.ts (importing it pulls the WGSL pipeline).
const STROKE_RGB: [number, number, number][] = [
  [0.92, 0.92, 0.92], [0.93, 0.42, 0.46], [0.95, 0.65, 0.28],
  [0.48, 0.80, 0.48], [0.38, 0.68, 0.98], [0.68, 0.58, 0.98],
];
const FILL_RGB: [number, number, number][] = [
  [0.83, 0.83, 0.83], [0.88, 0.36, 0.40], [0.90, 0.58, 0.22],
  [0.40, 0.72, 0.40], [0.32, 0.60, 0.92], [0.60, 0.50, 0.94],
];

function hexRgb(s: string | undefined): [number, number, number] | null {
  if (!s || s === "transparent") return null;
  const m = s.match(/^#?([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Nearest palette index; near-neutral colors snap to ink (index 0). */
function nearestIdx(rgb: [number, number, number], pal: [number, number, number][]): number {
  const spread = Math.max(...rgb) - Math.min(...rgb);
  if (spread < 0.2) return 0;
  let best = 0, bd = Infinity;
  pal.forEach((c, i) => {
    const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

const fontOf = (ff: unknown): WbFont | undefined =>
  ff === 1 || ff === 5 ? "hand" : ff === 3 ? "mono" : "inter";

const headOf = (h: unknown, dflt: boolean): WbArrowhead =>
  h === "arrow" ? "arrow" : h === "triangle" ? "triangle" : h === "dot" ? "dot"
    : h ? "arrow" : (dflt ? "arrow" : "none");

const flat = (pts: unknown): number[] =>
  Array.isArray(pts) ? (pts as number[][]).flatMap(p => [p[0] ?? 0, p[1] ?? 0]) : [];

const clamp01 = (v: number) => v < 0 ? 0 : v > 1 ? 1 : v;

interface XEl {
  id: string; type: string; x: number; y: number; width: number; height: number;
  angle?: number; strokeColor?: string; backgroundColor?: string;
  fillStyle?: string; strokeWidth?: number; strokeStyle?: string;
  roughness?: number; opacity?: number; isDeleted?: boolean;
  groupIds?: string[]; frameId?: string | null; roundness?: unknown;
  points?: number[][]; text?: string; fontSize?: number; fontFamily?: number;
  containerId?: string | null; fileId?: string | null;
  startArrowhead?: string | null; endArrowhead?: string | null;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  boundElements?: { id: string; type: string }[] | null;
  name?: string;
}

function dataUrlBytes(u: string): Uint8Array | null {
  const m = u.match(/^data:[^;,]*;base64,(.+)$/s);
  if (!m) return null;
  try {
    return new Uint8Array(Buffer.from(m[1]!, "base64"));
  } catch {
    return null;
  }
}

/** Excalidraw scene JSON → WbContent. Embedded images are written to
 *  workspace/assets via `putAsset` and referenced by "image" items. */
function canvasToWb(json: string, putAsset: (png: Uint8Array) => string): WbContent {
  let raw: { elements?: XEl[]; appState?: { scrollX?: number; scrollY?: number; zoom?: { value?: number } }; files?: Record<string, { dataURL?: string }> };
  try {
    raw = JSON.parse(json);
  } catch {
    return { v: 2, items: [], cam: { x: 0, y: 0, zoom: 1 } };
  }
  const files = raw.files ?? {};
  const els = (raw.elements ?? []).filter(e => !e.isDeleted);
  const byId = new Map<string, XEl>();
  els.forEach(e => byId.set(e.id, e));

  const items: WbItem[] = [];
  const idOf = new Map<string, string>(); // excalidraw id → wb item id
  const boundTexts: { host: string; text: string; fontSize?: number; font?: WbFont }[] = [];
  const arrows: { it: WbItem; e: XEl }[] = [];

  const base = (e: XEl): WbItem => ({
    id: newId("wb"), kind: "rect",
    x: e.x ?? 0, y: e.y ?? 0, w: e.width ?? 0, h: e.height ?? 0,
    color: nearestIdx(hexRgb(e.strokeColor) ?? [0.12, 0.12, 0.12], STROKE_RGB),
    fill: hexRgb(e.backgroundColor) ? nearestIdx(hexRgb(e.backgroundColor)!, FILL_RGB) : -1,
    fillStyle: e.fillStyle === "solid" ? "solid" : e.fillStyle === "cross-hatch" ? "cross" : "hachure",
    strokeStyle: e.strokeStyle === "dashed" ? "dashed" : e.strokeStyle === "dotted" ? "dotted" : "solid",
    roughness: typeof e.roughness === "number" ? e.roughness : 1,
    size: e.strokeWidth ?? 2,
    opacity: Math.max(0, Math.min(1, (e.opacity ?? 100) / 100)),
    angle: e.angle ?? 0,
    round: !!e.roundness,
    startArrow: "none", endArrow: "none",
    group: e.groupIds?.[0],
  });

  els.forEach(e => {
    if (e.type === "text" && e.containerId) {
      boundTexts.push({ host: e.containerId, text: e.text ?? "", fontSize: e.fontSize, font: fontOf(e.fontFamily) });
      return;
    }
    let it: WbItem | null = null;
    switch (e.type) {
      case "rectangle": case "diamond": case "ellipse":
        it = { ...base(e), kind: e.type === "rectangle" ? "rect" : e.type };
        break;
      case "frame":
        it = { ...base(e), kind: "rect", fill: -1, strokeStyle: "dashed", boundText: e.name ?? "", fontSize: 20 };
        break;
      case "line": case "arrow":
        it = {
          ...base(e), kind: e.type, points: flat(e.points),
          startArrow: headOf(e.startArrowhead, false), endArrow: headOf(e.endArrowhead, e.type === "arrow"),
        };
        arrows.push({ it, e });
        break;
      case "freedraw":
        it = { ...base(e), kind: "stroke", points: flat(e.points) };
        break;
      case "text":
        it = { ...base(e), kind: "text", text: e.text ?? "", size: e.fontSize ?? 20, font: fontOf(e.fontFamily) };
        break;
      case "image": {
        const fe = e.fileId ? files[e.fileId] : undefined;
        const png = fe?.dataURL ? dataUrlBytes(fe.dataURL) : null;
        it = { ...base(e), kind: "image", asset: png ? putAsset(png) : undefined };
        break;
      }
      default:
        break;
    }
    if (!it) return;
    it = normalizeWbItem(it);
    items.push(it);
    idOf.set(e.id, it.id);
  });

  boundTexts.forEach(bt => {
    const host = items.find(i => i.id === idOf.get(bt.host));
    if (!host) return;
    host.boundText = bt.text;
    if (bt.fontSize) host.fontSize = bt.fontSize;
    if (bt.font) host.font = bt.font;
  });

  // Arrow endpoint bindings: excalidraw anchors an endpoint somewhere along
  // the host outline; WbBinding stores the fractional position in the frame.
  arrows.forEach(({ it, e }) => {
    const pts = it.points ?? [];
    const endpoint = (start: boolean): [number, number] =>
      start ? [it.x + (pts[0] ?? 0), it.y + (pts[1] ?? 0)]
        : [it.x + (pts[pts.length - 2] ?? 0), it.y + (pts[pts.length - 1] ?? 0)];
    const mk = (b: { elementId: string } | null | undefined, start: boolean) => {
      if (!b) return null;
      const hostEl = byId.get(b.elementId);
      const hostId = idOf.get(b.elementId);
      if (!hostEl || !hostId) return null;
      const [px, py] = endpoint(start);
      return { id: hostId, fx: clamp01((px - hostEl.x) / (hostEl.width || 1)), fy: clamp01((py - hostEl.y) / (hostEl.height || 1)) };
    };
    it.bindStart = mk(e.startBinding, true);
    it.bindEnd = mk(e.endBinding, false);
  });

  const as = raw.appState ?? {};
  return {
    v: 2, items,
    cam: { x: -(as.scrollX ?? 0), y: -(as.scrollY ?? 0), zoom: as.zoom?.value ?? 1 },
  };
}

// ── workspace write ─────────────────────────────────────────────────────────

interface PageMetaOut {
  id: string; title: string; type: "doc" | "board" | "whiteboard";
  parentId: string | null; children: string[]; icon: string | null;
  favorite: boolean; deleted: boolean; expanded: boolean;
  createdAt: number; updatedAt: number;
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

async function main(): Promise<void> {
  if (!existsSync(join(WS, "pages"))) {
    console.error(`workspace not found: ${WS}`);
    process.exit(1);
  }
  mkdirSync(join(WS, "assets"), { recursive: true });

  // Collect items from all sources; earlier sources win on path conflicts,
  // and their .trash suppresses same-path items in later sources.
  const items = new Map<string, Item>();
  const taken = new Set<string>();   // paths owned by an earlier source
  const trashed = new Set<string>(); // paths deleted in an earlier source
  SRCS.forEach(src => {
    if (!existsSync(src)) {
      console.warn(`source missing, skipped: ${src}`);
      return;
    }
    const s = scanLibrary(src);
    s.items.forEach(it => {
      const key = it.rel.join("/");
      if (taken.has(key) || trashed.has(key)) return;
      items.set(key, it);
      taken.add(key);
    });
    s.present.forEach(k => taken.add(k));
    s.trashed.forEach(k => trashed.add(k));
  });

  const putAsset = (png: Uint8Array): string => {
    const id = createHash("sha256").update(png).digest("hex").slice(0, 24);
    const path = join(WS, "assets", `${id}.png`);
    if (!existsSync(path)) writeFileSync(path, png);
    return id;
  };

  // Build pages: directories first so parents exist for children.
  const dirIds = new Map<string, string>(); // rel-dir-path → page id
  const pages = new Map<string, PageMetaOut>();
  const contents = new Map<string, unknown>();
  const pageItem = new Map<string, Item>(); // page id → source item (ordering)
  const stats = { dirs: 0, docs: 0, codes: 0, boards: 0, images: 0, skipped: 0 };

  const mkMeta = (title: string, type: PageMetaOut["type"], it: Item): PageMetaOut => ({
    id: newId("page"), title, type, parentId: null, children: [],
    icon: null, favorite: false, deleted: false, expanded: true,
    createdAt: it.created ?? Date.now(), updatedAt: it.modified ?? Date.now(),
  });

  const emptyDoc = (): Doc => ({ blocks: [{ id: newBlockId(), kind: "paragraph", spans: [] }] });

  const sorted = [...items.values()].sort((a, b) => a.rel.length - b.rel.length);
  sorted.forEach(it => {
    const dirKey = it.rel.slice(0, -1).join("/");
    let meta: PageMetaOut;
    if (it.kind === "directory") {
      meta = mkMeta(it.title, "doc", it);
      contents.set(meta.id, { type: "doc", doc: emptyDoc() });
      dirIds.set(it.rel.join("/"), meta.id);
      stats.dirs++;
    } else if (it.kind === "canvas") {
      meta = mkMeta(it.title, "whiteboard", it);
      let wb: WbContent;
      try {
        wb = canvasToWb(readFileSync(it.file, "utf8"), putAsset);
      } catch (e) {
        console.warn(`canvas failed ${it.rel.join("/")}: ${e}`);
        wb = { v: 2, items: [], cam: { x: 0, y: 0, zoom: 1 } };
      }
      stats.images += wb.items.filter(i => i.kind === "image").length;
      contents.set(meta.id, { type: "whiteboard", wb });
      stats.boards++;
    } else {
      meta = mkMeta(it.title, "doc", it);
      try {
        const doc = it.kind === "code" ? codeToDoc(it.file) : mdToDoc(readFileSync(it.file, "utf8"));
        contents.set(meta.id, { type: "doc", doc });
        if (it.kind === "code") stats.codes++; else stats.docs++;
      } catch (e) {
        console.warn(`doc failed ${it.rel.join("/")}: ${e}`);
        contents.set(meta.id, { type: "doc", doc: emptyDoc() });
        stats.skipped++;
      }
    }
    meta.parentId = dirIds.get(dirKey) ?? null;
    pages.set(meta.id, meta);
    pageItem.set(meta.id, it);
    if (meta.parentId) pages.get(meta.parentId)!.children.push(meta.id);
  });

  // Order siblings by the source `order` field (fallback: title).
  const cmpPages = (a: string, b: string): number => {
    const ia = pageItem.get(a)!, ib = pageItem.get(b)!;
    return (ia.order - ib.order) || ia.title.localeCompare(ib.title);
  };
  pages.forEach(p => p.children.sort(cmpPages));
  const rootIds = [...pages.values()].filter(p => !p.parentId).map(p => p.id).sort(cmpPages);

  console.log(`items: ${items.size} — dirs:${stats.dirs} docs:${stats.docs} code:${stats.codes} boards:${stats.boards} images:${stats.images} failed:${stats.skipped}`);

  if (DRY) {
    rootIds.forEach(id => {
      const p = pages.get(id)!;
      const it = pageItem.get(id)!;
      console.log(`  /${p.title} (${p.type}) ← ${it.file || it.rel.join("/")}${p.children.length ? ` +${p.children.length} kids` : ""}`);
    });
    return;
  }

  // Merge into workspace.json — drop any previous import first.
  const metaPath = join(WS, "workspace.json");
  const meta = existsSync(metaPath)
    ? JSON.parse(readFileSync(metaPath, "utf8")) as { pages?: Record<string, PageMetaOut>; rootOrder?: string[] }
    : {};
  meta.pages ??= {};
  meta.rootOrder ??= [];

  let prev: string[] = [];
  try {
    prev = (JSON.parse(readFileSync(MARKER, "utf8")) as { pageIds?: string[] }).pageIds ?? [];
  } catch { /* no prior import */ }
  prev.forEach(id => {
    delete meta.pages![id];
    const ix = meta.rootOrder!.indexOf(id);
    if (ix >= 0) meta.rootOrder!.splice(ix, 1);
    Object.values(meta.pages!).forEach(p => {
      const ci = p.children.indexOf(id);
      if (ci >= 0) p.children.splice(ci, 1);
    });
    try { unlinkSync(join(WS, "pages", `${id}.json`)); } catch { /* gone */ }
  });

  const importedIds: string[] = [];
  pages.forEach(p => {
    importedIds.push(p.id);
    meta.pages![p.id] = p;
  });
  meta.rootOrder!.push(...rootIds);
  contents.forEach((c, id) => atomicWrite(join(WS, "pages", `${id}.json`), JSON.stringify(c, null, 1)));
  atomicWrite(metaPath, JSON.stringify({ ...meta, version: 1, savedAt: Date.now() }, null, 1));
  writeFileSync(MARKER, JSON.stringify({ at: Date.now(), pageIds: importedIds }, null, 1));

  // Rasterize non-raster assets (SVG dataURLs) in place — the asset id is a
  // hash of the original bytes, so the file keeps its name; image_shim_decode
  // only decodes raster formats.
  const assetsDir = join(WS, "assets");
  let rasterized = 0;
  const files = readdirSync(assetsDir);
  for (let i = 0; i < files.length; i++) {
    const p = join(assetsDir, files[i]!);
    const buf = readFileSync(p);
    if (buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) continue;
    try {
      writeFileSync(p, await sharp(buf, { density: 144 }).png().toBuffer());
      rasterized++;
    } catch (e) {
      console.warn(`asset ${files[i]}: rasterize failed (${e})`);
    }
  }
  if (rasterized) console.log(`rasterized ${rasterized} non-PNG asset(s)`);
  console.log(`wrote ${importedIds.length} pages → ${WS} (restart salticus to load)`);
}

void main();
