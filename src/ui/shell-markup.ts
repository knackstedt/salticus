// ============================================================================
// shell-markup.ts — markup templates for the sidebar + topbar docs.
// String templates (not JSX) — the docs re-render wholesale on chrome-relevant
// store changes; this is cheap since panels are small.
// ============================================================================

import { type AppState, type PageMeta } from "../app/store";
import { icon } from "./icons";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function typeIcon(p: PageMeta): string {
  const name = p.type === "doc" ? "doc" : p.type === "board" ? "board" : "canvas";
  return icon(name, 14);
}

function treeItems(s: AppState, parentId: string | null, depth: number): string {
  const ids = parentId === null
    ? s.rootOrder
    : (s.pages[parentId]?.children ?? []);
  let out = "";
  for (const id of ids) {
    const p = s.pages[id];
    if (!p || p.deleted) continue;
    out += pageItem(s, p, depth);
    if (p.children.length > 0) out += treeItems(s, id, depth + 1);
  }
  return out;
}

function pageItem(s: AppState, p: PageMeta, depth: number): string {
  const active = s.activePageId === p.id ? ` data-active="true"` : "";
  const pad = 10 + depth * 14;
  return `
    <div class="gn-item"${active} data-action="open-page" data-id="${esc(p.id)}" style="padding-left:${pad}px">
      <span class="ic">${typeIcon(p)}</span>
      <span class="lb">${esc(p.title) || "Untitled"}</span>
    </div>`;
}

export function sidebarMarkup(s: AppState): string {
  const favs = Object.values(s.pages).filter((p) => p.favorite && !p.deleted);
  const favHtml = favs.length > 0
    ? `<div class="gn-section">FAVORITES</div>` + favs.map((p) => pageItem(s, p, 0)).join("")
    : "";
  const tree = treeItems(s, null, 0);
  const pagesHtml = tree.length > 0
    ? tree
    : `<div class="gn-item" data-action="new-page" style="padding-left:10px"><span class="ic">${icon("plus", 14)}</span><span class="lb gn-faint">New page</span></div>`;
  return `
    <div class="gn-col" style="height:${s.windowH}px;overflow:hidden">
      <div class="gn-row" style="padding:12px 10px 6px;gap:8px">
        <div style="width:20px;height:20px;border-radius:5px;background:#8f7cf6;text-align:center;color:#fff;font-size:12px;line-height:20px;flex:none">G</div>
        <div class="gn-grow" style="font-weight:600;font-size:13px">Graphic Notes</div>
        <div class="gn-btn" data-action="toggle-theme" style="padding:3px 5px">${icon("moon", 13)}</div>
      </div>
      <div style="padding:4px 8px">
        <div class="gn-item" data-action="toggle-palette"><span class="ic">${icon("search", 14)}</span><span class="lb">Search</span></div>
      </div>
      ${favHtml}
      <div class="gn-section gn-row"><span class="gn-grow">PAGES</span><span class="gn-btn" data-action="new-page" style="padding:1px 4px">${icon("plus", 13)}</span></div>
      <div class="gn-col" style="gap:1px;padding:0 6px">
        ${pagesHtml}
      </div>
      <div class="gn-grow"></div>
      <div class="gn-divider"></div>
      <div style="padding:0 8px 10px">
        <div class="gn-item"><span class="ic">${icon("trash", 14)}</span><span class="lb">Trash</span></div>
        <div class="gn-item"><span class="ic">${icon("gear", 14)}</span><span class="lb">Settings</span></div>
      </div>
    </div>`;
}

export function topbarMarkup(s: AppState): string {
  const tabs = s.openTabs
    .map((id) => s.pages[id])
    .filter((p): p is PageMeta => !!p)
    .map((p) => {
      const active = s.activePageId === p.id ? ` data-active="true"` : "";
      return `
        <div class="gn-tab"${active} data-action="open-page" data-id="${esc(p.id)}">
          ${typeIcon(p)}
          <span style="overflow:hidden">${esc(p.title) || "Untitled"}</span>
          <span class="x" data-action="close-tab" data-id="${esc(p.id)}">${icon("close", 9)}</span>
        </div>`;
    })
    .join("");
  const active = s.activePageId ? s.pages[s.activePageId] : null;
  const crumb = active ? esc(active.title) || "Untitled" : "";
  const save = s.saveIndicator === "saving" ? "Saving…" : s.saveIndicator === "error" ? "Save error" : "Saved";
  return `
    <div class="gn-row" style="height:100%;padding:0 8px;gap:4px;border-bottom:1px solid var(--dd-line, #2a2d33)">
      <div class="gn-faint" style="font-size:12px;padding-right:6px">${crumb}</div>
      <div class="gn-row gn-grow" style="gap:2px">${tabs}</div>
      <div class="gn-faint" style="font-size:11px;padding:0 6px">${save}</div>
    </div>`;
}
