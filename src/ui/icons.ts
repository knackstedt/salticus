// ============================================================================
// icons.ts — inline SVG icon set (line icons, AppFlowy-style). Registered as
// ui://icons/*.svg resources; referenced from markup via <img>.
// ============================================================================

const S = (paths: string, extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" ${extra}>${paths}</svg>`;

export const ICONS: Record<string, string> = {
  search: S(`<circle cx="7" cy="7" r="4.2"/><path d="M10.4 10.4 L14 14"/>`),
  plus: S(`<path d="M8 3v10M3 8h10"/>`),
  doc: S(`<path d="M4 1.8h5.4L12.2 5v9.2H4z"/><path d="M9.4 1.8V5h2.8"/><path d="M5.8 7.6h4.4M5.8 10h4.4"/>`),
  board: S(`<rect x="2" y="2" width="3.4" height="12" rx="0.8"/><rect x="6.4" y="2" width="3.4" height="8" rx="0.8"/><rect x="10.8" y="2" width="3.2" height="10" rx="0.8"/>`),
  canvas: S(`<path d="M2 11.5c2-1 3-4.5 4-4.5s1.5 3 2.7 3 1.8-2.5 3.3-3.5"/><circle cx="12" cy="4.5" r="1.8"/><path d="M2 2v12h12" opacity="0.4"/>`),
  trash: S(`<path d="M2.8 4h10.4"/><path d="M6.2 4V2.4h3.6V4"/><path d="M4 4l.7 9.6h6.6L12 4"/><path d="M6.6 6.6v4.4M9.4 6.6v4.4"/>`),
  gear: S(`<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1"/>`),
  star: S(`<path d="M8 2.2l1.8 3.7 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4-2.9-2.8 4-.6z"/>`),
  chevron: S(`<path d="M6 4l4 4-4 4"/>`),
  chevronDown: S(`<path d="M4 6l4 4 4-4"/>`),
  close: S(`<path d="M4 4l8 8M12 4l-8 8"/>`),
  dots: S(`<circle cx="4" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="8" r="1" fill="currentColor" stroke="none"/>`),
  home: S(`<path d="M2.5 7L8 2.5 13.5 7"/><path d="M4 6.5V13.5h8V6.5"/>`),
  clock: S(`<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.4 1.6"/>`),
  keyboard: S(`<rect x="1.8" y="4" width="12.4" height="8.5" rx="1"/><path d="M4.5 6.5h.8M7 6.5h.8M9.5 6.5h.8M12 6.5h.8M4.5 9h.8M12 9h-.8M6.5 9h3"/>`),
  moon: S(`<path d="M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5z"/>`),
  sun: S(`<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M3.3 3.3l1 1M11.7 11.7l1 1M12.7 3.3l-1 1M4.3 11.7l-1 1"/>`),
  undo: S(`<path d="M3 6.5h7a3.2 3.2 0 0 1 0 6.4H6"/><path d="M5.5 4L3 6.5l2.5 2.5"/>`),
  link: S(`<path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-1.2 1.2"/><path d="M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l1.2-1.2"/>`),
  image: S(`<rect x="2" y="2.5" width="12" height="11" rx="1"/><circle cx="5.4" cy="6" r="1.2"/><path d="M2.5 11.5l3.5-3.5 2.5 2.5 3-3 2.5 2.5"/>`),
  calendar: S(`<rect x="2" y="3" width="12" height="11" rx="1"/><path d="M2 6.4h12M5.2 1.8V4M10.8 1.8V4"/>`),
  grid: S(`<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M2 6h12M2 10h12M6 2v12M10 2v12"/>`),
  check: S(`<path d="M2.5 8.5l3.5 3.5 7.5-8"/>`),
  edit: S(`<path d="M9.8 3.2l3 3L6 13H3v-3z"/><path d="M8.5 4.5l3 3"/>`),
};

export function icon(name: string, size = 15, cls = ""): string {
  const clsAttr = cls ? ` class="${cls}"` : "";
  return `<img src="ui://icons/${name}.svg" width="${size}" height="${size}"${clsAttr} style="display:block"/>`;
}

/** Register each SVG with a baked stroke color (usvg may not resolve
 *  currentColor from CSS — bake it). Returns [uiUrl, bytes] pairs. */
export function iconBytes(color = "#9aa0a8"): Array<[string, Uint8Array]> {
  const enc = new TextEncoder();
  return Object.entries(ICONS).map(([name, svg]) => [
    `ui://icons/${name}.svg`,
    enc.encode(svg.replaceAll("currentColor", color)),
  ]);
}
