// ============================================================================
// demo-doc.ts — a sample document exercising every block kind + span style.
// Used until workspace storage lands (Phase 3).
// ============================================================================

import { newBlockId, type Doc, type TextStyle } from "../editor/model";

const T = (over: Partial<TextStyle> = {}): TextStyle => ({
  family: "inter",
  weight: 400,
  italic: false,
  sizePx: 16,
  color: [0.82, 0.84, 0.90, 1],
  ...over,
});

export function demoDoc(): Doc {
  return {
    blocks: [
      { id: newBlockId(), kind: "h1", spans: [{ text: "Salticus", style: T({ weight: 700 }) }] },
      {
        id: newBlockId(), kind: "paragraph", spans: [
          { text: "A ", style: T() },
          { text: "GPU-native", style: T({ weight: 600, color: [0.37, 0.90, 0.66, 1] }) },
          { text: " note-taking surface rendered with ", style: T() },
          { text: "custom text shaping", style: T({ italic: true }) },
          { text: ", a coverage atlas, and an instanced quad pipeline. Every glyph you see was rasterized by cosmic-text, shaped by HarfBuzz, and drawn by our own WGSL pass.", style: T() },
        ],
      },
      { id: newBlockId(), kind: "h2", spans: [{ text: "Why not a DOM?", style: T() }] },
      {
        id: newBlockId(), kind: "paragraph", spans: [
          { text: "Blitz renders the chrome; this editor is different — the text pipeline is ours. Caret motion is spring-animated, scrolling is smoothed, and the whole document redraws as a single instanced draw call.", style: T() },
        ],
      },
      {
        id: newBlockId(), kind: "quote", spans: [
          { text: "The best interface is the one that disappears — text should feel printed, not painted.", style: T({ italic: true }) },
        ],
      },
      { id: newBlockId(), kind: "h3", spans: [{ text: "Inline styles", style: T() }] },
      {
        id: newBlockId(), kind: "paragraph", spans: [
          { text: "Runs can be ", style: T() },
          { text: "bold", style: T({ weight: 700 }) },
          { text: ", ", style: T() },
          { text: "italic", style: T({ italic: true }) },
          { text: ", ", style: T() },
          { text: "underline", style: T({ underline: true }) },
          { text: ", ", style: T() },
          { text: "strikethrough", style: T({ strikethrough: true }) },
          { text: ", or ", style: T() },
          { text: "code", style: T({ code: true }) },
          { text: " — mixed freely inside a paragraph, wrapping with real kerning and ligatures like ", style: T() },
          { text: "fi fl ffi", style: T({ italic: true }) },
          { text: ".", style: T() },
        ],
      },
      { id: newBlockId(), kind: "bullet", spans: [{ text: "Nested blocks wrap at the indent", style: T() }] },
      { id: newBlockId(), kind: "bullet", spans: [{ text: "Bullet markers draw as GPU quads", style: T() }] },
      { id: newBlockId(), kind: "number", num: 1, spans: [{ text: "Numbered items get a counter", style: T() }] },
      { id: newBlockId(), kind: "divider", spans: [] },
      {
        id: newBlockId(), kind: "codeblock", lang: "ts", spans: [
          { text: "fn shape(text: &str, face: Face) -> Run {\n    let glyphs = rustybuzz::shape(face, text);\n    Run::from_glyphs(glyphs)\n}", style: T({ sizePx: 13 }) },
        ],
      },
      {
        id: newBlockId(), kind: "callout", spans: [
          { text: "Tip — click anywhere to move the caret; drag to select; scroll to pan the document.", style: T() },
        ],
      },
      { id: newBlockId(), kind: "paragraph", spans: [{ text: "", style: T() }] },
    ],
  };
}
