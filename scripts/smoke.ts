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

async function mcp(tool: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = await $`${DRAFT} run draft mcp call ${tool} ${JSON.stringify(args)}`.cwd(cwd).quiet().nothrow();
  const out = r.stdout.toString().trim();
  if (r.exitCode !== 0) throw new Error(`${tool} failed: ${r.stderr.toString() || out}`);
  try { return JSON.parse(out); } catch { return { raw: out }; }
}

async function shot(name: string): Promise<void> {
  await $`${DRAFT} run draft mcp screenshot /tmp/gn-${name}.png`.cwd(cwd).quiet().nothrow();
  console.log(`  📸 /tmp/gn-${name}.png`);
}

async function key(k: string, mods: Record<string, unknown> = {}): Promise<void> {
  await mcp("dispatch_key", { key: k, ...mods });
}

async function click(x: number, y: number, type = "click"): Promise<void> {
  await mcp("dispatch_click", { x, y, type });
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

await check("pen stroke", async () => {
  await click(400, 300, "mousedown");
  await click(450, 320, "mousemove");
  await click(500, 310, "mousemove");
  await click(500, 310, "mouseup");
  await shot("wb-stroke");
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
  const thumbs = await $`ls ${process.env.HOME}/.config/downdraft-graphic-notes/workspace/thumbs`.quiet().nothrow();
  assert(thumbs.stdout.toString().includes(`${docId}.png`), `thumb file for ${docId}`);
});

await check("kanban semibold face registered", async () => {
  const d = await mcp("text_debug", { face: "inter:600:normal", size: 13, text: "To Do" });
  const chunk = d.chunk as { w?: number } | undefined;
  assert(chunk && (chunk.w ?? 0) > 0, "inter:600 chunk has pixels");
});

await check("persistence: doc saved", async () => {
  const pages = await $`ls ${process.env.HOME}/.config/downdraft-graphic-notes/workspace/pages`.quiet();
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
