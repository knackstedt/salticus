// ============================================================================
// fonts.ts — font registry for the editor text pipeline.
//
// Each face is identified by a canonical key "family:weight:style" and has a
// file path (for the cosmic-text rasterizer) plus raw bytes (for harfbuzz
// shaping). Bundled fonts live in assets/fonts/.
// ============================================================================

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { FaceDef } from "./run-cache";

const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../assets/fonts");

export type FontStyle = "normal" | "italic";
export type FontFamily = "inter" | "jetbrains" | "hand";

/** Face key used for emoji/fallback runs — glyphs missing from the primary
 *  face get re-shaped against this one. */
export const EMOJI_FACE = "emoji:400:normal";

const FACE_FILES: Record<FontFamily, Partial<Record<number, Partial<Record<FontStyle, string>>>>> = {
  inter: {
    400: { normal: "Inter-Regular.ttf", italic: "Inter-Italic.ttf" },
    500: { normal: "Inter-Medium.ttf", italic: "Inter-MediumItalic.ttf" },
    600: { normal: "Inter-SemiBold.ttf", italic: "Inter-SemiBoldItalic.ttf" },
    700: { normal: "Inter-Bold.ttf", italic: "Inter-BoldItalic.ttf" },
  },
  jetbrains: {
    400: { normal: "JetBrainsMono-Regular.ttf", italic: "JetBrainsMono-Italic.ttf" },
    500: { normal: "JetBrainsMono-Medium.ttf" },
    700: { normal: "JetBrainsMono-Bold.ttf" },
  },
  // Hand-drawn face for the whiteboard (Caveat, OFL — stands in for
  // Excalidraw's Virgil). Variable font: both weights share the file.
  hand: {
    400: { normal: "Caveat-Regular.ttf" },
    700: { normal: "Caveat-Regular.ttf" },
  },
};

export function faceKey(family: FontFamily, weight: number, style: FontStyle = "normal"): string {
  return `${family}:${weight}:${style}`;
}

/** Nearest available weight for a family. */
export function resolveWeight(family: FontFamily, weight: number): number {
  const weights = Object.keys(FACE_FILES[family]).map(Number).sort((a, b) => a - b);
  let best = weights[0]!;
  weights.forEach(w => { if (Math.abs(w - weight) < Math.abs(best - weight)) best = w; });
  return best;
}

// Fallback faces live in the system font dir (too large to bundle). Runs
// containing codepoints missing from the primary face are re-shaped against
// each fallback in order — wide-coverage text faces first, emoji last since
// it renders as monochrome silhouettes. First existing candidate path wins;
// missing faces are skipped entirely.
export const FALLBACK_FACES: { key: string; candidates: string[] }[] = [
  {
    // Latin-ext, punctuation, currency, arrows, box drawing, combining marks.
    key: "noto-sans:400:normal",
    candidates: [
      "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
      "/usr/share/fonts/noto/NotoSans-Regular.ttf",
    ],
  },
  {
    // Math operators and alphanumeric symbols.
    key: "noto-math:400:normal",
    candidates: ["/usr/share/fonts/truetype/noto/NotoSansMath-Regular.ttf"],
  },
  {
    // Dingbats, ornaments, enclosed alphanumerics, bracket pieces.
    key: "noto-symbols2:400:normal",
    candidates: ["/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf"],
  },
  {
    // CJK unified ideographs, kana, hangul, fullwidth forms.
    key: "noto-cjk:400:normal",
    candidates: [
      "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
      "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
      "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    ],
  },
  {
    key: EMOJI_FACE,
    candidates: [
      "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
      "/usr/share/fonts/noto/NotoColorEmoji.ttf",
      "/usr/share/fonts/opentype/noto/NotoColorEmoji.ttf",
      "/System/Library/Fonts/Apple Color Emoji.ttc",
    ],
  },
];

/** Load every registered face (bytes for harfbuzz + path for ft_shim). */
export async function loadFaces(): Promise<FaceDef[]> {
  const defs: FaceDef[] = [];
  for (let fi = 0; fi < FALLBACK_FACES.length; fi++) {
    const fb = FALLBACK_FACES[fi]!;
    for (let pi = 0; pi < fb.candidates.length && !defs.some(d => d.key === fb.key); pi++) {
      try {
        const p = fb.candidates[pi]!;
        defs.push({
          key: fb.key, path: p,
          data: new Uint8Array(await readFile(p)),
          // Color-emoji bitmaps strike at a huge size — oversample then
          // downscale so glyphs land at text size.
          rasterScale: fb.key === EMOJI_FACE ? 4 : undefined,
        });
      } catch { /* try next candidate */ }
    }
  }
  const families = Object.keys(FACE_FILES) as FontFamily[];
  for (let fi = 0; fi < families.length; fi++) {
    const fam = families[fi]!;
    const weights = Object.keys(FACE_FILES[fam]).map(Number);
    for (let wi = 0; wi < weights.length; wi++) {
      const w = weights[wi]!;
      const styles = FACE_FILES[fam][w]!;
      const styleKeys = Object.keys(styles) as FontStyle[];
      for (let si = 0; si < styleKeys.length; si++) {
        const s = styleKeys[si]!;
        const file = styles[s]!;
        const path = join(FONTS_DIR, file);
        defs.push({
          key: faceKey(fam, w, s),
          path,
          data: new Uint8Array(await readFile(path)),
        });
      }
    }
  }
  return defs;
}
