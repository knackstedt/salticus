// ============================================================================
// theme.ts — design tokens + CSS for the html-ui chrome. Dark-first like
// AppFlowy; tokens switch via a `data-theme` attr on <body>.
// ============================================================================

export interface ThemeTokens {
  bg: string;
  bgPanel: string;
  bgHover: string;
  bgActive: string;
  bgElev: string;
  line: string;
  lineSoft: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  accentSoft: string;
  accentText: string;
  sel: string;
  selSoft: string;
  codeBg: string;
  danger: string;
  good: string;
  warn: string;
}

export const DARK: ThemeTokens = {
  bg: "#191b1e",
  bgPanel: "#1f2125",
  bgHover: "#292c31",
  bgActive: "#2f3339",
  bgElev: "#24272c",
  line: "#33373d",
  lineSoft: "#2a2d33",
  text: "#e8e9eb",
  textDim: "#9aa0a8",
  textFaint: "#676c75",
  accent: "#8f7cf6",
  accentSoft: "#8f7cf626",
  accentText: "#b5a8fa",
  sel: "#3d63c9",
  selSoft: "#3d63c94d",
  codeBg: "#15171a",
  danger: "#e5534b",
  good: "#6fbf73",
  warn: "#f0a04b",
};

export const LIGHT: ThemeTokens = {
  bg: "#ffffff",
  bgPanel: "#f7f7f5",
  bgHover: "#efefed",
  bgActive: "#e8e8e5",
  bgElev: "#ffffff",
  line: "#e2e2de",
  lineSoft: "#ebebe8",
  text: "#28282a",
  textDim: "#6e6e6e",
  textFaint: "#a3a3a3",
  accent: "#7a63e8",
  accentSoft: "#7a63e81c",
  accentText: "#6a53e0",
  sel: "#9ab8f0",
  selSoft: "#9ab8f04d",
  codeBg: "#f4f4f2",
  danger: "#d93b34",
  good: "#3d994a",
  warn: "#c97f1b",
};

export function tokens(name: "dark" | "light"): ThemeTokens {
  return name === "dark" ? DARK : LIGHT;
}

/** CSS shared by every chrome doc — tokens are resolved at mount (static
 *  per theme; panels re-render on theme switch). */
export function chromeCss(t: ThemeTokens): string {
  return `
* { margin:0; padding:0; box-sizing:border-box; }
html, body { height: 100%; }
body { background: transparent; color: ${t.text}; font-family: 'Inter'; font-size: 13px; overflow: hidden; }

.gn-panel { background: ${t.bgPanel}; }
.gn-row { display: flex; align-items: center; }
.gn-col { display: flex; flex-direction: column; }
.gn-grow { flex: 1; }
.gn-dim { color: ${t.textDim}; }
.gn-faint { color: ${t.textFaint}; }

.gn-item { display: flex; align-items: center; gap: 6px; padding: 4px 8px;
  border-radius: 5px; color: ${t.textDim}; font-size: 13px; position: relative; }
.gn-item:hover { background: ${t.bgHover}; color: ${t.text}; }
.gn-item[data-active="true"] { background: ${t.bgActive}; color: ${t.text}; }
.gn-item .ic { width: 18px; text-align: center; flex: none; }
.gn-item .lb { flex: 1; overflow: hidden; }
.gn-item .tw { width: 14px; flex: none; display: flex; align-items: center;
  justify-content: center; color: ${t.textFaint}; border-radius: 3px; }
.gn-item .tw:hover { background: ${t.bgActive}; color: ${t.text}; }
.gn-item .fav { opacity: 0; padding: 1px 3px; border-radius: 3px; color: ${t.textFaint}; flex: none; }
.gn-item:hover .fav, .gn-item .fav.on { opacity: 1; }
.gn-item .fav:hover { background: ${t.bgActive}; color: ${t.warn}; }
.gn-item .fav.add:hover { color: ${t.text}; }
.gn-item .fav.on { color: ${t.warn}; }
.gn-item .thumb-pop { display: none; position: absolute; left: 10px; top: 26px;
  z-index: 50; width: 226px; background: ${t.bgElev}; border: 1px solid ${t.line};
  border-radius: 8px; padding: 6px; box-shadow: 0 6px 20px #0006; }
.gn-item:hover .thumb-pop { display: block; }
.thumb-pop .thumb-img { width: 214px; border-radius: 5px; display: block;
  border: 1px solid ${t.lineSoft}; }
.thumb-pop .tt { font-size: 11px; color: ${t.textDim}; padding: 5px 2px 1px;
  overflow: hidden; }
.gn-btn[data-active="true"] { background: ${t.bgActive}; color: ${t.text}; }

.gn-section { font-size: 11px; font-weight: 600; color: ${t.textFaint};
  letter-spacing: 0.4px; padding: 14px 10px 4px; }

.gn-btn { display: inline-block; padding: 5px 10px; border-radius: 5px;
  color: ${t.textDim}; font-size: 12.5px; }
.gn-btn:hover { background: ${t.bgHover}; color: ${t.text}; }
.gn-btn[data-kind="accent"] { background: ${t.accent}; color: #fff; }
.gn-btn[data-kind="accent"]:hover { filter: brightness(1.1); color: #fff; }

.gn-tab { display: flex; align-items: center; gap: 6px; padding: 4px 10px;
  border-radius: 5px; color: ${t.textDim}; font-size: 12.5px; max-width: 160px;
  min-width: 0; flex: 0 1 auto; }
.gn-tab:hover { background: ${t.bgHover}; color: ${t.text}; }
.gn-tab[data-active="true"] { background: ${t.bg}; color: ${t.text};
  border: 1px solid ${t.lineSoft}; padding: 3px 9px; }
.gn-tab .x { color: ${t.textFaint}; border-radius: 3px; padding: 0 3px; }
.gn-tab .x:hover { color: ${t.text}; background: ${t.bgActive}; }

.gn-input { background: ${t.bgHover}; color: ${t.text}; border: 1px solid ${t.line};
  border-radius: 5px; padding: 5px 9px; font-size: 13px; font-family: 'Inter'; }
.gn-input:focus { border-color: ${t.accent}; }

.gn-divider { height: 1px; background: ${t.lineSoft}; margin: 6px 4px; }

.gn-menu { background: ${t.bgElev}; border: 1px solid ${t.line}; border-radius: 8px;
  padding: 5px; min-width: 180px; }
.gn-menu .mi { display: flex; align-items: center; gap: 8px; padding: 5px 9px;
  border-radius: 5px; color: ${t.text}; font-size: 13px; }
.gn-menu .mi:hover { background: ${t.accentSoft}; }
.gn-menu .mi[data-kind="danger"]:hover { background: ${t.danger}22; color: ${t.danger}; }
`;
}
