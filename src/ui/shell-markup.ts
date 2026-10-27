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
    out += pageItem(s, p, depth, true);
    if (p.children.length > 0 && p.expanded) out += treeItems(s, id, depth + 1);
  }
  return out;
}

function pageItem(s: AppState, p: PageMeta, depth: number, inTree = false): string {
  const active = s.activePageId === p.id ? ` data-active="true"` : "";
  const pad = 4 + depth * 14;
  const hasKids = p.children.some((c) => s.pages[c] && !s.pages[c]!.deleted);
  const twist = hasKids
    ? `<span class="tw" data-action="toggle-expand" data-id="${esc(p.id)}">${icon(p.expanded ? "chevronDown" : "chevron", 11)}</span>`
    : `<span class="tw"></span>`;
  const renaming = inTree && s.renamingId === p.id;
  const add = renaming ? "" : `<span class="fav add" data-action="new-subpage" data-id="${esc(p.id)}" title="New sub-page">${icon("plus", 11)}</span>`;
  const fav = renaming ? "" : `<span class="fav${p.favorite ? " on" : ""}" data-action="fav-page" data-id="${esc(p.id)}">${icon("star", 11)}</span>`;
  const label = renaming
    ? `<input class="sc-input" data-rename-input="1" value="${esc(s.renamingDraft)}" style="flex:1;min-width:0;padding:2px 6px;font-size:12.5px"/>`
    : `<span class="lb">${esc(p.title) || "Untitled"}</span>`;
  return `
    <div class="sc-item"${active} data-action="open-page" data-id="${esc(p.id)}" data-menu="page" style="padding-left:${pad}px">
      ${twist}
      <span class="ic">${typeIcon(p)}</span>
      ${label}
      ${add}${fav}
    </div>`;
}

function trashView(s: AppState): string {
  const trashed = Object.values(s.pages).filter((p) => p.deleted);
  const rows = trashed.length > 0
    ? trashed.map((p) => `
      <div class="sc-item" data-menu="trash" data-id="${esc(p.id)}" style="padding-left:10px">
        <span class="ic">${typeIcon(p)}</span>
        <span class="lb">${esc(p.title) || "Untitled"}</span>
        <span class="fav" data-action="restore-page" data-id="${esc(p.id)}" title="Restore">${icon("undo", 11)}</span>
        <span class="fav" data-action="destroy-page" data-id="${esc(p.id)}" title="Delete forever">${icon("close", 10)}</span>
      </div>`).join("")
    : `<div class="sc-faint" style="padding:8px 14px;font-size:12px">No deleted pages</div>`;
  return `
    <div class="sc-section sc-row">
      <span class="sc-btn" data-action="sidebar-view" data-view="pages" style="padding:1px 4px">${icon("chevron", 12)}</span>
      <span class="sc-grow">TRASH</span>
    </div>
    <div class="sc-col" style="gap:1px;padding:0 6px">${rows}</div>
    <div class="sc-grow"></div>`;
}

function settingsView(s: AppState): string {
  const themeBtn = (name: "dark" | "light", label: string) =>
    `<div class="sc-btn" data-action="set-theme" data-theme="${name}" data-active="${s.theme === name}" style="text-align:center;flex:1">${label}</div>`;
  return `
    <div class="sc-section sc-row">
      <span class="sc-btn" data-action="sidebar-view" data-view="pages" style="padding:1px 4px">${icon("chevron", 12)}</span>
      <span class="sc-grow">SETTINGS</span>
    </div>
    <div style="padding:4px 14px">
      <div class="sc-faint" style="font-size:11px;padding-bottom:6px">Theme</div>
      <div class="sc-row" style="gap:6px">${themeBtn("dark", "Dark")}${themeBtn("light", "Light")}</div>
      <div class="sc-faint" style="font-size:11px;padding:14px 0 6px">Editor</div>
      <div class="sc-row" style="gap:6px">
        <div class="sc-dim" style="font-size:12px;flex:1">Animations</div>
        <div class="sc-btn" data-action="toggle-animations" data-active="${s.editorAnimations}">${s.editorAnimations ? "On" : "Off"}</div>
      </div>
      <div class="sc-faint" style="font-size:11px;padding:14px 0 6px">Workspace</div>
      <div class="sc-dim" style="font-size:11px">JSON workspace · autosave on</div>
      <div class="sc-faint" style="font-size:11px;padding-top:14px">Salticus — built on the DownDraft WebGPU engine.</div>
    </div>
    <div class="sc-grow"></div>`;
}

export function sidebarMarkup(s: AppState): string {
  const favs = Object.values(s.pages).filter((p) => p.favorite && !p.deleted);
  const favHtml = favs.length > 0
    ? `<div class="sc-section">FAVORITES</div>` + favs.map((p) => pageItem(s, p, 0)).join("")
    : "";
  const tree = treeItems(s, null, 0);
  const pagesHtml = tree.length > 0
    ? tree
    : `<div class="sc-item" data-action="new-page" style="padding-left:10px"><span class="ic">${icon("plus", 14)}</span><span class="lb sc-faint">New page</span></div>`;
  const body = s.sidebarView === "trash" ? trashView(s)
    : s.sidebarView === "settings" ? settingsView(s)
    : `${favHtml}
      <div class="sc-section sc-row"><span class="sc-grow">PAGES</span>
        <span class="sc-btn" data-action="new-page" data-type="doc" title="New doc" style="padding:1px 4px">${icon("doc", 12)}</span>
        <span class="sc-btn" data-action="new-page" data-type="board" title="New board" style="padding:1px 4px">${icon("board", 12)}</span>
        <span class="sc-btn" data-action="new-page" data-type="whiteboard" title="New canvas" style="padding:1px 4px">${icon("canvas", 12)}</span>
      </div>
      <div class="sc-col" style="gap:1px;padding:0 6px">
        ${pagesHtml}
      </div>
      <div class="sc-grow"></div>`;
  return `
    <div class="sc-col" style="height:${Math.round(s.windowH / s.dpr)}px;overflow:hidden">
      <div class="sc-row" style="padding:12px 10px 6px;gap:8px">
        <div style="width:20px;height:20px;border-radius:5px;background:#8f7cf6;text-align:center;color:#fff;font-size:12px;line-height:20px;flex:none">S</div>
        <div class="sc-grow" style="font-weight:600;font-size:13px">Salticus</div>
        <div class="sc-btn" data-action="toggle-theme" style="padding:3px 5px">${icon(s.theme === "dark" ? "moon" : "sun", 13)}</div>
      </div>
      <div style="padding:4px 8px">
        <div class="sc-item" data-action="toggle-palette"><span class="ic">${icon("search", 14)}</span><span class="lb">Search</span></div>
      </div>
      ${body}
      <div class="sc-divider"></div>
      <div style="padding:0 8px 10px">
        <div class="sc-item"${s.sidebarView === "trash" ? ' data-active="true"' : ""} data-action="sidebar-view" data-view="trash"><span class="ic">${icon("trash", 14)}</span><span class="lb">Trash</span></div>
        <div class="sc-item"${s.sidebarView === "settings" ? ' data-active="true"' : ""} data-action="sidebar-view" data-view="settings"><span class="ic">${icon("gear", 14)}</span><span class="lb">Settings</span></div>
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
        <div class="sc-tab"${active} data-action="open-page" data-id="${esc(p.id)}" data-menu="tab">
          ${typeIcon(p)}
          <span style="overflow:hidden;white-space:nowrap;flex:0 1 auto">${esc(p.title) || "Untitled"}</span>
          <span class="x" data-action="close-tab" data-id="${esc(p.id)}" style="flex:none">${icon("close", 9)}</span>
        </div>`;
    })
    .join("");
  const active = s.activePageId ? s.pages[s.activePageId] : null;
  let crumb = "";
  if (active) {
    // Ancestor chain as a breadcrumb — e.g. "Second Note / Sub Note A".
    const chain: string[] = [];
    let cur: PageMeta | undefined = active;
    let guard = 0;
    while (cur && guard++ < 16) {
      chain.unshift(esc(cur.title) || "Untitled");
      cur = cur.parentId ? s.pages[cur.parentId] : undefined;
    }
    crumb = chain.join(" / ");
  }
  const save = s.saveIndicator === "saving" ? "Saving…" : s.saveIndicator === "error" ? "Save error" : "Saved";
  return `
    <div class="sc-row" style="height:100%;padding:0 8px;gap:4px;border-bottom:1px solid var(--dd-line, #2a2d33)">
      <div class="sc-faint" style="font-size:12px;padding-right:6px">${crumb}</div>
      <div class="sc-row sc-grow" style="gap:2px;overflow:hidden;flex-wrap:nowrap">${tabs}</div>
      <div class="sc-faint" style="font-size:11px;padding:0 6px;flex:none">${save}</div>
    </div>`;
}

// ── Page/tab context menu ────────────────────────────────────────────────────

export type CtxMenuKind = "page" | "tab" | "trash";

const CTX_W = 218;
const CTX_ROW = 27;
const CTX_SEP = 9;

/** Right-click menu for sidebar page rows, topbar tabs, and trash rows.
 *  Rendered inside a full-window backdrop panel — clicks anywhere off the
 *  menu fall through to the backdrop's ctx-dismiss action. (x, y) are
 *  screen-space px. */
export function ctxMenuMarkup(s: AppState, pageId: string, kind: CtxMenuKind, x: number, y: number): string {
  const p = s.pages[pageId];
  if (!p) return "";
  const mi = (action: string, label: string, opts: { danger?: boolean; icon?: string } = {}) =>
    `<div class="mi"${opts.danger ? ' data-kind="danger"' : ""} data-action="${action}" data-id="${esc(pageId)}">` +
    `${opts.icon ? `<span style="display:flex">${icon(opts.icon, 12)}</span>` : ""}` +
    `<span class="sc-grow">${esc(label)}</span></div>`;
  const sep = `<div class="sc-divider" style="margin:3px 2px"></div>`;
  let items = "";
  let h = 10;
  const add = (html: string, hh: number) => { items += html; h += hh; };
  if (kind === "trash") {
    add(mi("ctx-restore", "Restore", { icon: "undo" }), CTX_ROW);
    add(sep, CTX_SEP);
    add(mi("ctx-destroy", "Delete forever", { icon: "close", danger: true }), CTX_ROW);
  } else {
    add(mi("ctx-open", "Open", { icon: typeIconName(p) }), CTX_ROW);
    if (kind === "tab") {
      add(mi("ctx-close", "Close tab"), CTX_ROW);
      add(mi("ctx-close-others", "Close other tabs"), CTX_ROW);
      add(mi("ctx-close-all", "Close all tabs"), CTX_ROW);
    }
    add(sep, CTX_SEP);
    add(mi("ctx-rename", "Rename", { icon: "edit" }), CTX_ROW);
    add(mi("ctx-fav", p.favorite ? "Remove from favorites" : "Add to favorites", { icon: "star" }), CTX_ROW);
    add(mi("ctx-copy-link", "Copy link", { icon: "link" }), CTX_ROW);
    add(mi("ctx-new-sub", "New sub-page", { icon: "plus" }), CTX_ROW);
    add(mi("ctx-dup", "Duplicate", { icon: "doc" }), CTX_ROW);
    add(sep, CTX_SEP);
    add(mi("ctx-trash", "Move to trash", { icon: "trash", danger: true }), CTX_ROW);
  }
  const mx = Math.min(Math.max(4, x), Math.max(4, s.windowW / s.dpr - CTX_W - 4));
  const my = Math.min(Math.max(4, y), Math.max(4, s.windowH / s.dpr - h - 4));
  return `
    <div style="position:relative;width:100%;height:100%" data-action="ctx-dismiss">
      <div class="sc-menu" style="position:absolute;left:${mx}px;top:${my}px;width:${CTX_W}px">${items}</div>
    </div>`;
}

function typeIconName(p: PageMeta): string {
  return p.type === "doc" ? "doc" : p.type === "board" ? "board" : "canvas";
}
