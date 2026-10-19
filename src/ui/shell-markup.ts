// ============================================================================
// shell-markup.ts — markup templates for the sidebar + topbar docs.
// String templates (not JSX) — the docs re-render wholesale on chrome-relevant
// store changes; this is cheap since panels are small.
// ============================================================================

import { type AppState, type PageMeta } from "../app/store";
import { hasThumb, thumbUrl } from "../app/thumbnails";
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
    if (p.children.length > 0 && p.expanded) out += treeItems(s, id, depth + 1);
  }
  return out;
}

function pageItem(s: AppState, p: PageMeta, depth: number): string {
  const active = s.activePageId === p.id ? ` data-active="true"` : "";
  const pad = 4 + depth * 14;
  const hasKids = p.children.some((c) => s.pages[c] && !s.pages[c]!.deleted);
  const twist = hasKids
    ? `<span class="tw" data-action="toggle-expand" data-id="${esc(p.id)}">${icon(p.expanded ? "chevronDown" : "chevron", 11)}</span>`
    : `<span class="tw"></span>`;
  const add = `<span class="fav add" data-action="new-subpage" data-id="${esc(p.id)}" title="New sub-page">${icon("plus", 11)}</span>`;
  const fav = `<span class="fav${p.favorite ? " on" : ""}" data-action="fav-page" data-id="${esc(p.id)}">${icon("star", 11)}</span>`;
  const pop = hasThumb(p.id) ? `
    <div class="thumb-pop">
      <img src="${thumbUrl(p.id)}" class="thumb-img"/>
      <div class="tt">${esc(p.title) || "Untitled"}</div>
    </div>` : "";
  return `
    <div class="gn-item"${active} data-action="open-page" data-id="${esc(p.id)}" style="padding-left:${pad}px">
      ${twist}
      <span class="ic">${typeIcon(p)}</span>
      <span class="lb">${esc(p.title) || "Untitled"}</span>
      ${add}${fav}
      ${pop}
    </div>`;
}

function trashView(s: AppState): string {
  const trashed = Object.values(s.pages).filter((p) => p.deleted);
  const rows = trashed.length > 0
    ? trashed.map((p) => `
      <div class="gn-item" style="padding-left:10px">
        <span class="ic">${typeIcon(p)}</span>
        <span class="lb">${esc(p.title) || "Untitled"}</span>
        <span class="fav" data-action="restore-page" data-id="${esc(p.id)}" title="Restore">${icon("undo", 11)}</span>
        <span class="fav" data-action="destroy-page" data-id="${esc(p.id)}" title="Delete forever">${icon("close", 10)}</span>
      </div>`).join("")
    : `<div class="gn-faint" style="padding:8px 14px;font-size:12px">No deleted pages</div>`;
  return `
    <div class="gn-section gn-row">
      <span class="gn-btn" data-action="sidebar-view" data-view="pages" style="padding:1px 4px">${icon("chevron", 12)}</span>
      <span class="gn-grow">TRASH</span>
    </div>
    <div class="gn-col" style="gap:1px;padding:0 6px">${rows}</div>
    <div class="gn-grow"></div>`;
}

function settingsView(s: AppState): string {
  const themeBtn = (name: "dark" | "light", label: string) =>
    `<div class="gn-btn" data-action="set-theme" data-theme="${name}" data-active="${s.theme === name}" style="text-align:center;flex:1">${label}</div>`;
  return `
    <div class="gn-section gn-row">
      <span class="gn-btn" data-action="sidebar-view" data-view="pages" style="padding:1px 4px">${icon("chevron", 12)}</span>
      <span class="gn-grow">SETTINGS</span>
    </div>
    <div style="padding:4px 14px">
      <div class="gn-faint" style="font-size:11px;padding-bottom:6px">Theme</div>
      <div class="gn-row" style="gap:6px">${themeBtn("dark", "Dark")}${themeBtn("light", "Light")}</div>
      <div class="gn-faint" style="font-size:11px;padding:14px 0 6px">Editor</div>
      <div class="gn-row" style="gap:6px">
        <div class="gn-dim" style="font-size:12px;flex:1">Animations</div>
        <div class="gn-btn" data-action="toggle-animations" data-active="${s.editorAnimations}">${s.editorAnimations ? "On" : "Off"}</div>
      </div>
      <div class="gn-faint" style="font-size:11px;padding:14px 0 6px">Workspace</div>
      <div class="gn-dim" style="font-size:11px">JSON workspace · autosave on</div>
      <div class="gn-faint" style="font-size:11px;padding-top:14px">Graphic Notes — built on the DownDraft WebGPU engine.</div>
    </div>
    <div class="gn-grow"></div>`;
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
  const body = s.sidebarView === "trash" ? trashView(s)
    : s.sidebarView === "settings" ? settingsView(s)
    : `${favHtml}
      <div class="gn-section gn-row"><span class="gn-grow">PAGES</span>
        <span class="gn-btn" data-action="new-page" data-type="doc" title="New doc" style="padding:1px 4px">${icon("doc", 12)}</span>
        <span class="gn-btn" data-action="new-page" data-type="board" title="New board" style="padding:1px 4px">${icon("board", 12)}</span>
        <span class="gn-btn" data-action="new-page" data-type="whiteboard" title="New canvas" style="padding:1px 4px">${icon("canvas", 12)}</span>
      </div>
      <div class="gn-col" style="gap:1px;padding:0 6px">
        ${pagesHtml}
      </div>
      <div class="gn-grow"></div>`;
  return `
    <div class="gn-col" style="height:${s.windowH}px;overflow:hidden">
      <div class="gn-row" style="padding:12px 10px 6px;gap:8px">
        <div style="width:20px;height:20px;border-radius:5px;background:#8f7cf6;text-align:center;color:#fff;font-size:12px;line-height:20px;flex:none">G</div>
        <div class="gn-grow" style="font-weight:600;font-size:13px">Graphic Notes</div>
        <div class="gn-btn" data-action="toggle-theme" style="padding:3px 5px">${icon(s.theme === "dark" ? "moon" : "sun", 13)}</div>
      </div>
      <div style="padding:4px 8px">
        <div class="gn-item" data-action="toggle-palette"><span class="ic">${icon("search", 14)}</span><span class="lb">Search</span></div>
      </div>
      ${body}
      <div class="gn-divider"></div>
      <div style="padding:0 8px 10px">
        <div class="gn-item"${s.sidebarView === "trash" ? ' data-active="true"' : ""} data-action="sidebar-view" data-view="trash"><span class="ic">${icon("trash", 14)}</span><span class="lb">Trash</span></div>
        <div class="gn-item"${s.sidebarView === "settings" ? ' data-active="true"' : ""} data-action="sidebar-view" data-view="settings"><span class="ic">${icon("gear", 14)}</span><span class="lb">Settings</span></div>
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
    <div class="gn-row" style="height:100%;padding:0 8px;gap:4px;border-bottom:1px solid var(--dd-line, #2a2d33)">
      <div class="gn-faint" style="font-size:12px;padding-right:6px">${crumb}</div>
      <div class="gn-row gn-grow" style="gap:2px;overflow:hidden;flex-wrap:nowrap">${tabs}</div>
      <div class="gn-faint" style="font-size:11px;padding:0 6px;flex:none">${save}</div>
    </div>`;
}
