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
export type FontFamily = "inter" | "jetbrains";

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
};

export function faceKey(family: FontFamily, weight: number, style: FontStyle = "normal"): string {
  return `${family}:${weight}:${style}`;
}

/** Nearest available weight for a family. */
export function resolveWeight(family: FontFamily, weight: number): number {
  const weights = Object.keys(FACE_FILES[family]).map(Number).sort((a, b) => a - b);
  let best = weights[0]!;
  for (const w of weights) if (Math.abs(w - weight) < Math.abs(best - weight)) best = w;
  return best;
}

/** Load every registered face (bytes for harfbuzz + path for ft_shim). */
export async function loadFaces(): Promise<FaceDef[]> {
  const defs: FaceDef[] = [];
  const families = Object.keys(FACE_FILES) as FontFamily[];
  for (const fam of families) {
    const weights = Object.keys(FACE_FILES[fam]).map(Number);
    for (const w of weights) {
      const styles = FACE_FILES[fam][w]!;
      const styleKeys = Object.keys(styles) as FontStyle[];
      for (const s of styleKeys) {
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
