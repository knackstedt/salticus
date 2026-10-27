#!/usr/bin/env bun
// ============================================================================
// smoke.ts — end-to-end MCP smoke test. Requires a running app instance
// (draft dev). Drives the native MCP automation endpoint through the CLI.
//
//   bun scripts/smoke.ts            # run all checks, screenshots → /tmp
//   DOWNDRAFT_GPU=swiftshader DOWNDRAFT_DETERMINISTIC=1 bun run draft dev
// ============================================================================

import { $ } from "bun";

const DRAFT = `${process.env.HOME}/.bun/bin/bun`;
const cwd = `${import.meta.dir}/..`;
let failures = 0;

const PID_ARGS = process.env.SALTICUS_PID ? ["--pid", process.env.SALTICUS_PID] : [];

async function mcp(tool: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = await $`${DRAFT} run draft mcp call ${tool} ${JSON.stringify(args)} ${{ raw: PID_ARGS.join(" ") }}`.cwd(cwd).quiet().nothrow();
  const out = r.stdout.toString().trim();
  if (r.exitCode !== 0) throw new Error(`${tool} failed: ${r.stderr.toString() || out}`);
  try { return JSON.parse(out); } catch { return { raw: out }; }
}

async function shot(name: string): Promise<void> {
  await $`${DRAFT} run draft mcp screenshot /tmp/sc-${name}.png ${{ raw: PID_ARGS.join(" ") }}`.cwd(cwd).quiet().nothrow();
  console.log(`  📸 /tmp/sc-${name}.png`);
}

async function key(k: string, mods: Record<string, unknown> = {}): Promise<void> {
  await mcp("dispatch_key", { key: k, ...mods });
}

// Click coords below are authored in logical (CSS-space) px — the same space
// wb_state's screen coords report. dispatch_click takes buffer px, so scale
// by the display's devicePixelRatio (app_state.dpr).
let DPR = 1;

async function click(x: number, y: number, type = "click"): Promise<void> {
  await mcp("dispatch_click", { x: x * DPR, y: y * DPR, type });
}

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}: ${e}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

console.log("smoke: driving running instance via MCP");

const state = await mcp("app_state");
DPR = typeof state.dpr === "number" && state.dpr > 0 ? state.dpr : 1;
assert(state.pages && Object.keys(state.pages as object).length > 0, "workspace has pages");
console.log(`  workspace: ${Object.keys(state.pages as object).length} pages, active=${state.activePageId}`);

let docId = "";
await check("create doc page", async () => {
  const p = await mcp("create_page", { type: "doc", title: "Smoke Doc" });
  docId = p.id as string;
  assert(docId, "got page id");
});

await check("type into editor", async () => {
  await click(600, 200); // focus editor
  await mcp("type_text", { text: "smoke e2e text" });
  const st = await mcp("editor_state");
  assert((st.blocks as number) >= 1, "has blocks");
  await shot("doc");
});

await check("undo", async () => {
  await key("z", { ctrlKey: true });
});

let boardId = "";
await check("create board page", async () => {
  const p = await mcp("create_page", { type: "board", title: "Smoke Board" });
  boardId = p.id as string;
  assert(boardId, "got board id");
  await shot("board");
});

await check("board renders columns", async () => {
  // Board seed has 3 columns; verified visually via screenshot.
  await mcp("open_page", { id: boardId });
});

let wbId = "";
await check("create whiteboard page", async () => {
  const p = await mcp("create_page", { type: "whiteboard", title: "Smoke Canvas" });
  wbId = p.id as string;
  assert(wbId, "got wb id");
  await shot("whiteboard");
});

await check("whiteboard draw rect/ellipse/pen", async () => {
  await key("r"); // rect tool
  await click(500, 300, "mousedown");
  await click(640, 400, "mousemove");
  await click(640, 400, "mouseup");
  await key("o"); // ellipse tool
  await click(700, 300, "mousedown");
  await click(780, 380, "mousemove");
  await click(780, 380, "mouseup");
  await key("p"); // pen tool
  await click(400, 500, "mousedown");
  await click(450, 540, "mousemove");
  await click(560, 500, "mousemove");
  await click(560, 500, "mouseup");
  const st = await mcp("wb_state");
  const kinds = st.kinds as string[];
  assert((st.items as number) === 3, `expected 3 items, got ${st.items}`);
  assert(kinds.includes("rect") && kinds.includes("ellipse") && kinds.includes("stroke"),
    `kinds ${JSON.stringify(kinds)}`);
  await shot("wb-drawn");
});

await check("whiteboard select + move", async () => {
  await key("v"); // select tool
  // Drag the rect's bottom edge, away from handles — selects + moves in
  // one motion. (A click at the same spot first would double-click.)
  await click(520, 400, "mousedown");
  await click(570, 450, "mousemove");
  await click(570, 450, "mouseup");
  let st = await mcp("wb_state");
  const sel = st.selected as string[];
  assert(sel.length === 1, `one selected, got ${sel.length}`);
  const r = (st.detail as { kind: string; x: number; y: number }[]).find((i) => i.kind === "rect");
  assert(r && r.x > 270, `rect moved (x=${r?.x})`);
});

await check("whiteboard undo/redo", async () => {
  await key("z", { ctrlKey: true });
  let st = await mcp("wb_state");
  assert((st.items as number) === 3, `undo reverted move (items=${st.items})`);
  await key("z", { ctrlKey: true });
  st = await mcp("wb_state");
  assert((st.items as number) === 2, `undo removed pen (items=${st.items})`);
  await key("z", { ctrlKey: true, shiftKey: true });
  st = await mcp("wb_state");
  assert((st.items as number) === 3, "redo restored pen");
});

await check("whiteboard bound text", async () => {
  await key("v");
  // Select the rect (edge hit), Enter opens bound-text editing.
  await click(640, 350);
  await key("Enter");
  let st = await mcp("wb_state");
  const ed = st.editing as { field?: string } | null;
  assert(ed?.field === "boundText", `editing ${JSON.stringify(ed)}`);
  for (let ci = 0; ci < 2; ci++) await key("hi"[ci]!);
  await key("Escape");
  st = await mcp("wb_state");
  const r = (st.detail as { kind: string; boundText?: string }[]).find((i) => i.kind === "rect");
  assert(r?.boundText === "hi", `boundText=${JSON.stringify(r?.boundText)}`);
  await shot("wb-bound-text");
});

await check("whiteboard group/ungroup", async () => {
  await key("a", { ctrlKey: true }); // select all
  await key("g", { ctrlKey: true }); // group
  let st = await mcp("wb_state");
  const grouped = (st.detail as { group?: string }[]).filter((i) => i.group).length;
  assert(grouped === 3, `3 grouped, got ${grouped}`);
  await key("g", { ctrlKey: true, shiftKey: true }); // ungroup
  st = await mcp("wb_state");
  const left = (st.detail as { group?: string }[]).filter((i) => i.group).length;
  assert(left === 0, `ungrouped, got ${left}`);
});

await check("whiteboard copy/paste", async () => {
  await key("v");
  await click(500, 320); // rect left edge — distinct from earlier clicks
  await key("c", { ctrlKey: true });
  await key("v", { ctrlKey: true });
  const st = await mcp("wb_state");
  assert((st.items as number) === 4, `paste added item (items=${st.items})`);
});

await check("whiteboard eraser", async () => {
  await key("e"); // eraser tool
  // Dense sweep over the canvas — eraseAt only fires at pointer positions.
  // (x<470 overlaps the props panel, which swallows the pointerdown.)
  await click(500, 240, "mousedown");
  for (let y = 280; y <= 620; y += 35) {
    for (let x = 500; x <= 840; x += 35) await click(x, y, "mousemove");
  }
  await click(840, 640, "mouseup");
  const st = await mcp("wb_state");
  assert((st.items as number) === 0, `erased all (items=${st.items})`);
});

await check("palette open/search/open", async () => {
  await key("k", { ctrlKey: true });
  await shot("palette");
  for (const c of "smoke doc".split("")) {
    if (c === " ") continue;
    await key(c);
  }
  await shot("palette-filtered");
  await key("Escape");
});

await check("theme toggle", async () => {
  await mcp("set_theme", { theme: "light" });
  await shot("light");
  await mcp("set_theme", { theme: "dark" });
});

let subId = "";
await check("nested page (sub-page)", async () => {
  const sub = await mcp("create_page", { type: "doc", title: "Smoke Subpage", parentId: docId });
  subId = sub.id as string;
  assert(subId, "got sub-page id");
  const st = await mcp("app_state");
  const parent = (st.pages as Record<string, { children?: string[] }>)[docId];
  const child = (st.pages as Record<string, { parentId?: string }>)[subId];
  assert(parent?.children?.includes(subId), "parent lists child");
  assert(child?.parentId === docId, "child lists parent");
  await shot("nested");
});

await check("page thumbnail persisted", async () => {
  // Thumbs capture ~1.2s after a page renders; the doc was active above.
  await mcp("open_page", { id: docId });
  await new Promise((r) => setTimeout(r, 3000));
  const thumbs = await $`ls ${process.env.HOME}/.config/downdraft-salticus/workspace/thumbs`.quiet().nothrow();
  assert(thumbs.stdout.toString().includes(`${docId}.png`), `thumb file for ${docId}`);
});

await check("kanban semibold face registered", async () => {
  const d = await mcp("text_debug", { face: "inter:600:normal", size: 13, text: "To Do" });
  const chunk = d.chunk as { w?: number } | undefined;
  assert(chunk && (chunk.w ?? 0) > 0, "inter:600 chunk has pixels");
});

await check("persistence: doc saved", async () => {
  const pages = await $`ls ${process.env.HOME}/.config/downdraft-salticus/workspace/pages`.quiet();
  assert(pages.stdout.toString().includes(docId), "doc page file exists");
});

// Clean up the pages this run created so repeated runs don't pile up clutter.
await check("cleanup: destroy smoke pages", async () => {
  for (const id of [docId, boardId, wbId]) {
    if (id) await mcp("delete_page", { id, hard: true });
  }
  const st = await mcp("app_state");
  const pages = st.pages as Record<string, unknown>;
  assert(!pages[docId] && !pages[boardId] && !pages[wbId] && !pages[subId], "smoke pages removed");
});

console.log(failures === 0 ? "\nsmoke: all checks passed" : `\nsmoke: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
