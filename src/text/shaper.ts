// ============================================================================
// shaper.ts — HarfBuzz shaping for layout metrics.
//
// The cosmic-text rasterizer gives us bitmaps; it does not give us cluster
// positions. harfbuzzjs does: we shape each run ourselves to recover
// per-character-boundary advance offsets (caret math) and font extents
// (baseline alignment / line height). HarfBuzz and rustybuzz implement the
// same engine, so positions agree with the rendered bitmaps.
//
// harfbuzzjs/dist/index.mjs initializes itself at module load (top-level
// await) and exports the classes — no factory needed.
// ============================================================================

import { Blob as HbBlob, Buffer as HbBuffer, Face as HbFace, Font as HbFont, shape as hbShape } from "harfbuzzjs";
import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger();

export interface ShapedRun {
  /** Total advance width in pixels (at the font scale set via sizePx). */
  advance: number;
  /** UTF-16 index → cumulative x offset from run start, in pixels.
   *  Length = text.length + 1. */
  clusterOffsets: Float32Array;
  /** Glyph count after shaping (may differ from text length — ligatures). */
  glyphCount: number;
}

export interface FaceMetrics {
  /** Ascender in pixels at this size (positive). */
  ascent: number;
  /** Descender in pixels at this size (positive — hb descender is negative). */
  descent: number;
  /** hb lineGap in pixels. */
  lineGap: number;
  /** Em size in font units. */
  upem: number;
}

interface FontEntry {
  blob: HbBlob;
  face: HbFace;
  font: HbFont;
}

/** Smallest distinct cluster value strictly greater than `c` in the glyph
 *  stream — the upper boundary of `c`'s coverage in UTF-16 space. */
function distinctAbove(infos: { cluster: number }[], fallback: number, c: number): number {
  let hi = fallback;
  for (let i = 0; i < infos.length; i++) {
    const v = infos[i]!.cluster;
    if (v > c && v < hi) hi = v;
  }
  return hi;
}

export class TextShaper {
  private fonts = new Map<string, FontEntry>();
  private hbBuffer: HbBuffer | null = null;
  private failed = false;

  async init(): Promise<boolean> {
    // The module is already initialized via top-level await by the time this
    // import resolves — just allocate our reusable buffer.
    if (this.hbBuffer) return true;
    try {
      this.hbBuffer = new HbBuffer();
      return true;
    } catch (e) {
      log.warn("shaper", `harfbuzz buffer alloc failed: ${e}`);
      this.failed = true;
      return false;
    }
  }

  get ready(): boolean {
    return this.hbBuffer !== null && !this.failed;
  }

  /** Register a face from raw font bytes (key = canonical face id). */
  addFace(key: string, data: Uint8Array): void {
    if (this.fonts.has(key)) return;
    try {
      const blob = new HbBlob(data);
      const face = new HbFace(blob, 0);
      const font = new HbFont(face);
      this.fonts.set(key, { blob, face, font });
    } catch (e) {
      log.warn("shaper", `addFace ${key} failed: ${e}`);
    }
  }

  upem(key: string): number {
    const f = this.fonts.get(key);
    return f ? f.face.upem : 1000;
  }

  /** Raw font entry (exposes face.upem + font.glyphExtents). */
  font(key: string): FontEntry | undefined {
    return this.fonts.get(key);
  }

  /** Font extents at a pixel size. `hExtents()` returns values in the font's
   *  current scale, so set the scale first — do NOT apply a upem factor again. */
  metrics(key: string, sizePx: number): FaceMetrics {
    const f = this.fonts.get(key);
    if (!f) return { ascent: sizePx * 0.8, descent: sizePx * 0.2, lineGap: 0, upem: 1000 };
    f.font.setScale(sizePx, sizePx);
    const ext = f.font.hExtents();
    return {
      ascent: ext.ascender,
      descent: -ext.descender,
      lineGap: ext.lineGap,
      upem: f.face.upem,
    };
  }

  /** Shape `text` in face `key` at `sizePx`; returns total advance plus
   *  cumulative x-offsets per UTF-16 boundary (index 0..text.length). */
  shape(key: string, text: string, sizePx: number): ShapedRun | null {
    const glyphs = this.shapeGlyphs(key, text, sizePx, true);
    if (!glyphs) return null;
    const { advance, clusterOffsets } = glyphs;
    return { advance, clusterOffsets: clusterOffsets!, glyphCount: glyphs.glyphCount };
  }

  /** Glyph-level shape output in pen space, optionally with per-boundary
   *  cluster offsets (caret math). Explicit clusters = UTF-16 indices so
   *  surrogate pairs map correctly. */
  shapeGlyphs(key: string, text: string, sizePx: number, withClusters = false): {
    glyphs: { glyphId: number; penX: number; penY: number; cluster: number }[];
    advance: number;
    clusterOffsets: Float32Array | null;
    glyphCount: number;
  } | null {
    const f = this.fonts.get(key);
    const buf = this.hbBuffer;
    if (!f || !buf || !text) return null;

    buf.reset();
    let i16 = 0;
    for (const cp of text) {
      buf.add(cp.codePointAt(0)!, i16);
      i16 += cp.length; // cp is a 1-2 UTF-16-unit string — astral chars take 2
    }
    buf.guessSegmentProperties();

    f.font.setScale(sizePx, sizePx);
    hbShape(f.font, buf);

    const infos = buf.getGlyphInfos();
    const positions = buf.getGlyphPositions();
    const glyphs: { glyphId: number; penX: number; penY: number; cluster: number }[] = [];
    const offsets = withClusters ? new Float32Array(text.length + 1) : null;

    // Direction of the whole buffer (bidi is a segment property, not per-
    // glyph): RTL runs emit glyphs in visual order with DESCENDING clusters.
    const rtl = infos.length > 1 && infos[0]!.cluster > infos[infos.length - 1]!.cluster;

    let penX = 0;
    let penY = 0;
    let nextBoundary = 0;
    for (let i = 0; i < infos.length; i++) {
      const cluster = Math.max(0, Math.min(text.length, infos[i]!.cluster));
      const adv = positions[i]!.xAdvance;
      glyphs.push({
        glyphId: infos[i]!.codepoint,
        penX: penX + positions[i]!.xOffset,
        penY: penY + positions[i]!.yOffset,
        cluster,
      });
      if (offsets) {
        // This glyph covers UTF-16 boundaries [cluster, hi] where hi is the
        // adjacent cluster value — the NEXT glyph's for LTR, the PREVIOUS
        // visual glyph's for RTL. Boundary j maps linearly between the
        // glyph's two visual edges (left for LTR, right for RTL at cluster).
        const nextCluster = i + 1 < infos.length
          ? Math.max(0, Math.min(text.length, infos[i + 1]!.cluster))
          : text.length;
        const hi = rtl ? distinctAbove(infos, text.length, cluster) : nextCluster;
        const lo = rtl ? cluster : Math.max(cluster, nextBoundary);
        if (hi > lo) {
          for (let j = lo; j <= hi; j++) {
            const t = (j - lo) / (hi - lo);
            offsets[j] = rtl ? penX + adv * (1 - t) : penX;
          }
        }
        nextBoundary = Math.max(nextBoundary, cluster + 1);
      }
      penX += adv;
      penY += positions[i]!.yAdvance;
    }
    if (offsets && !rtl) {
      for (let j = nextBoundary; j <= text.length; j++) offsets[j] = penX;
    }
    return { glyphs, advance: penX, clusterOffsets: offsets, glyphCount: infos.length };
  }

  dispose(): void {
    // harfbuzzjs objects are freed via FinalizationRegistry — just drop refs.
    this.hbBuffer = null;
    this.fonts.clear();
  }
}
