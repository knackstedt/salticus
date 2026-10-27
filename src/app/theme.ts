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
  bg: "#1b1b1b",
  bgPanel: "#222222",
  bgHover: "#2c2c2c",
  bgActive: "#363636",
  bgElev: "#292929",
  line: "#383838",
  lineSoft: "#2d2d2d",
  text: "#eaeaea",
  textDim: "#a3a3a3",
  textFaint: "#6e6e6e",
  accent: "#5EE6A8",
  accentSoft: "#5ee6a826",
  accentText: "#7df2c1",
  sel: "#2f9e72",
  selSoft: "#2f9e724d",
  codeBg: "#181818",
  danger: "#e5534b",
  good: "#6fbf73",
  warn: "#f0a04b",
};

export const LIGHT: ThemeTokens = {
  bg: "#ffffff",
  bgPanel: "#f6f6f6",
  bgHover: "#eeeeee",
  bgActive: "#e8e8e8",
  bgElev: "#ffffff",
  line: "#e1e1e1",
  lineSoft: "#eaeaea",
  text: "#282828",
  textDim: "#6e6e6e",
  textFaint: "#a3a3a3",
  accent: "#1fa26f",
  accentSoft: "#1fa26f1c",
  accentText: "#157a54",
  sel: "#8fdcb8",
  selSoft: "#8fdcb84d",
  codeBg: "#f4f4f4",
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

.sc-panel { background: ${t.bgPanel}; }
.sc-row { display: flex; align-items: center; }
.sc-col { display: flex; flex-direction: column; }
.sc-grow { flex: 1; }
.sc-dim { color: ${t.textDim}; }
.sc-faint { color: ${t.textFaint}; }

.sc-item { display: flex; align-items: center; gap: 6px; padding: 4px 8px;
  border-radius: 5px; color: ${t.textDim}; font-size: 13px; position: relative; }
.sc-item:hover { background: ${t.bgHover}; color: ${t.text}; }
.sc-item[data-active="true"] { background: ${t.bgActive}; color: ${t.text}; }
.sc-item .ic { width: 18px; text-align: center; flex: none; }
.sc-item .lb { flex: 1; overflow: hidden; }
.sc-item .tw { width: 14px; flex: none; display: flex; align-items: center;
  justify-content: center; color: ${t.textFaint}; border-radius: 3px; }
.sc-item .tw:hover { background: ${t.bgActive}; color: ${t.text}; }
.sc-item .fav { opacity: 0; padding: 1px 3px; border-radius: 3px; color: ${t.textFaint}; flex: none; }
.sc-item:hover .fav, .sc-item .fav.on { opacity: 1; }
.sc-item .fav:hover { background: ${t.bgActive}; color: ${t.warn}; }
.sc-item .fav.add:hover { color: ${t.text}; }
.sc-item .fav.on { color: ${t.warn}; }
.sc-btn[data-active="true"] { background: ${t.bgActive}; color: ${t.text}; }

.sc-section { font-size: 11px; font-weight: 600; color: ${t.textFaint};
  letter-spacing: 0.4px; padding: 14px 10px 4px; }

.sc-btn { display: inline-block; padding: 5px 10px; border-radius: 5px;
  color: ${t.textDim}; font-size: 12.5px; }
.sc-btn:hover { background: ${t.bgHover}; color: ${t.text}; }
.sc-btn[data-kind="accent"] { background: ${t.accent}; color: #fff; }
.sc-btn[data-kind="accent"]:hover { filter: brightness(1.1); color: #fff; }

.sc-tab { display: flex; align-items: center; gap: 6px; padding: 4px 10px;
  border-radius: 5px; color: ${t.textDim}; font-size: 12.5px; max-width: 160px;
  min-width: 0; flex: 0 1 auto; }
.sc-tab:hover { background: ${t.bgHover}; color: ${t.text}; }
.sc-tab[data-active="true"] { background: ${t.bg}; color: ${t.text};
  border: 1px solid ${t.lineSoft}; padding: 3px 9px; }
.sc-tab .x { color: ${t.textFaint}; border-radius: 3px; padding: 0 3px; }
.sc-tab .x:hover { color: ${t.text}; background: ${t.bgActive}; }

.sc-input { background: ${t.bgHover}; color: ${t.text}; border: 1px solid ${t.line};
  border-radius: 5px; padding: 5px 9px; font-size: 13px; font-family: 'Inter'; }
.sc-input:focus { border-color: ${t.accent}; }

.sc-divider { height: 1px; background: ${t.lineSoft}; margin: 6px 4px; }

.sc-menu { background: ${t.bgElev}; border: 1px solid ${t.line}; border-radius: 8px;
  padding: 5px; min-width: 180px; }
.sc-menu .mi { display: flex; align-items: center; gap: 8px; padding: 5px 9px;
  border-radius: 5px; color: ${t.text}; font-size: 13px; }
.sc-menu .mi:hover { background: ${t.accentSoft}; }
.sc-menu .mi[data-kind="danger"]:hover { background: ${t.danger}22; color: ${t.danger}; }
`;
}
