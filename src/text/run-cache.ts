// ============================================================================
// run-cache.ts — styled text → shape metrics + atlas bitmaps.
//
// Two cache layers:
//   getRun()   — shape info for a full run: advance, per-boundary cluster
//                offsets (caret/wrap math), font metrics, baseline. Cheap
//                (harfbuzz only), keyed by face|size|text.
//   getChunk() — rasterized atlas bitmap for an arbitrary substring. Lines
//                draw slices of runs, so bitmaps key on the substring they
//                actually rasterize.
//
// Baseline: calibrated per (face, size) by scanning the ink bottom of an
// "H" probe — that row IS the baseline inside the bitmap. Runs draw at
// `baseline - baselineInBitmap`, keeping mixed faces/sizes aligned without
// trusting cosmic's internal line metrics.
// ============================================================================

import { FtRasterizer } from "./ft";
import { TextShaper } from "./shaper";
import { TextAtlas, type AtlasRegion } from "./atlas";
import { CbdtFont } from "./cbdt";
import { ImageDecoder } from "./image-decode";
import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger();

export interface FaceDef {
  /** Canonical key, e.g. "inter:400:normal". */
  key: string;
  /** Font file path for ft_shim_init. */
  path: string;
  /** Raw font bytes for harfbuzzjs. */
  data: Uint8Array;
  /** Rasterize at this multiple of the logical size, then box-downscale —
   *  bitmap fonts (NotoColorEmoji's fixed CBDT strikes) can't rasterize at
   *  small sizes and return empty bitmaps without it. */
  rasterScale?: number;
}

export interface RunShape {
  /** Total advance in px. */
  advance: number;
  /** UTF-16 boundary → x offset (length text.length + 1). */
  clusterOffsets: Float32Array;
  /** Font ascent/descent in px at this size. */
  ascent: number;
  descent: number;
  /** Baseline distance from the top of chunk bitmaps at this face+size. */
  baselineInBitmap: number;
}

export interface ChunkBitmap {
  /** Atlas region (null for blank text — advance only). Region dims are the
   *  native bitmap size; `w`/`h` are the LOGICAL draw size — for color
   *  bitmap strikes the region is upscaled and the GPU stretch is free AA. */
  region: AtlasRegion | null;
  /** Left ink edge in pen space — draw at penX + inkX (overhangs go <0). */
  inkX: number;
  /** Draw dims in px. */
  w: number;
  h: number;
  baselineInBitmap: number;
  /** True when the bitmap carries real colors (CBDT emoji) — draw with the
   *  self-colored quad kind instead of the tinted coverage kind. */
  color?: boolean;
}

export class RunCache {
  private ft = new FtRasterizer();
  private shaper = new TextShaper();
  private imgDec = new ImageDecoder();
  private cbdtFaces = new Map<string, CbdtFont | null>();
  private cbdtGlyphs = new Map<string, { data: Uint8Array; width: number; height: number } | null>();
  private faces = new Map<string, FaceDef>();
  private handles = new Map<string, bigint>();
  private baselines = new Map<string, number>();
  private runs = new Map<string, RunShape>();
  private chunks = new Map<string, ChunkBitmap>();
  private missCache = new Map<string, [number, number][]>();
  private lru = new Map<string, number>();
  private tick = 0;

  constructor(readonly atlas: TextAtlas) {}

  get ready(): boolean {
    return this.ft.available && this.shaper.ready;
  }

  async init(): Promise<void> {
    await this.shaper.init();
  }

  registerFace(def: FaceDef): void {
    this.faces.set(def.key, def);
    this.shaper.addFace(def.key, def.data);
  }

  hasFace(key: string): boolean {
    return this.faces.has(key);
  }

  /** UTF-16 ranges that shape to .notdef in `face` — used to split emoji
   *  and other uncovered glyphs into fallback-face runs. Cluster-aligned,
   *  so ranges never split a surrogate pair or grapheme cluster. */
  missingRanges(face: string, sizePx: number, text: string): [number, number][] {
    if (!text || !this.faces.has(face) || !this.ready) return [];
    // Pure ASCII/Latin-1 is always covered by our bundled faces.
    if (!/[^\x00-\xff]/.test(text)) return [];
    const size = Math.max(1, Math.round(sizePx));
    const ck = `m|${face}@${size}\x00${text}`;
    const hit = this.missCache.get(ck);
    if (hit) { this.touch(ck); return hit; }
    const shaped = this.shaper.shapeGlyphs(face, text, size);
    const ranges: [number, number][] = [];
    if (shaped) {
      // A missing glyph's coverage = [its cluster, the SMALLEST distinct
      // cluster value above it). Multiple glyphs can share a cluster (a ZWJ
      // sequence shaped to several .notdef glyphs all report the sequence's
      // start), so the next array entry is NOT a reliable boundary. For RTL
      // runs glyph order is visual and clusters descend — a scan for the
      // smallest value > c is correct for both directions.
      const distinct: number[] = [];
      shaped.glyphs.forEach(g => {
        if (distinct[distinct.length - 1] !== g.cluster) distinct.push(g.cluster);
      });
      const nextBoundary = (c: number): number => {
        let best = text.length;
        for (let i = 0; i < distinct.length; i++) {
          const v = distinct[i]!;
          if (v > c && v < best) best = v;
        }
        return best;
      };
      const isLow = (i: number) => i < text.length && text.charCodeAt(i) >= 0xDC00 && text.charCodeAt(i) <= 0xDFFF;
      const isHigh = (i: number) => i >= 0 && text.charCodeAt(i) >= 0xD800 && text.charCodeAt(i) <= 0xDBFF;
      shaped.glyphs.forEach(g => {
        if (g.glyphId !== 0) return;
        let start = g.cluster;
        let end = nextBoundary(g.cluster);
        // Snap boundaries out of surrogate pairs — a range edge between a
        // high and low surrogate would split the codepoint in two.
        if (isLow(start) && isHigh(start - 1)) start--;
        if (isLow(end) && isHigh(end - 1)) end++;
        ranges.push([start, Math.max(end, start + 1)]);
      });
      // Ranges arrive in GLYPH order — descending for RTL runs — so sort
      // before merging overlaps.
      ranges.sort((a, b) => a[0] - b[0]);
      for (let i = ranges.length - 1; i > 0; i--) {
        const prev = ranges[i - 1]!, cur = ranges[i]!;
        if (cur[0] <= prev[1]) { prev[1] = Math.max(prev[1], cur[1]); ranges.splice(i, 1); }
      }
      // Merge ranges separated only by emoji glue — variation selectors
      // (FE00-FE0F), keycap/combining marks (20D0-20FF), tag chars
      // (E0020-E007F). These must travel WITH the emoji (❤+VS16 → emoji
      // heart). ZWJ deliberately excluded — the rasterizer can't ligate
      // ZWJ sequences, and 👨ZWJ👩 renders better as separate silhouettes
      // than as the fallback font's .notdef box.
      const glue = (cp: number) =>
        (cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0x20D0 && cp <= 0x20FF) ||
        (cp >= 0xE0020 && cp <= 0xE007F);
      for (let i = ranges.length - 1; i > 0; i--) {
        const prev = ranges[i - 1]!, cur = ranges[i]!;
        let joinable = cur[0] - prev[1] <= 4;
        for (let j = prev[1]; joinable && j < cur[0]; j++) {
          if (!glue(text.codePointAt(j)!)) joinable = false;
        }
        if (joinable) { prev[1] = cur[1]; ranges.splice(i, 1); }
      }
    }
    this.missCache.set(ck, ranges);
    this.touch(ck);
    return ranges;
  }

  /** Split `text` into ordered pieces tagged with the face that covers them:
   *  `face` where possible, otherwise the first face in `chain` that shapes
   *  without .notdef (last chain face takes whatever remains). ZWJ chars are
   *  emitted as their own primary-face pieces — fallback faces can't ligate
   *  ZWJ sequences, so pieces split there anyway. `start` is the piece's
   *  UTF-16 offset within `text`. */
  fallbackPieces(face: string, sizePx: number, text: string, chain: string[]): { face: string; text: string; start: number }[] {
    const out: { face: string; text: string; start: number }[] = [];
    const resolve = (piece: string, start: number, fi: number) => {
      const fk = chain[fi]!;
      const miss = this.missingRanges(fk, sizePx, piece);
      if (!miss.length) { out.push({ face: fk, text: piece, start }); return; }
      const last = fi === chain.length - 1;
      let cur = 0;
      miss.forEach(([a, b]) => {
        if (a > cur) out.push({ face: fk, text: piece.slice(cur, a), start: start + cur });
        if (!last) resolve(piece.slice(a, b), start + a, fi + 1);
        // Nothing in the chain covers this slice — let the PRIMARY face draw
        // its .notdef box rather than a blank in some fallback face.
        else out.push({ face, text: piece.slice(a, b), start: start + a });
        cur = b;
      });
      if (cur < piece.length) out.push({ face: fk, text: piece.slice(cur), start: start + cur });
    };
    const missing = chain.length ? this.missingRanges(face, sizePx, text) : [];
    let cursor = 0;
    missing.forEach(([ms, me]) => {
      if (ms > cursor) out.push({ face, text: text.slice(cursor, ms), start: cursor });
      let segStart = ms;
      for (let j = ms; j < me; j++) {
        if (text.charCodeAt(j) !== 0x200D) continue;
        if (j > segStart) resolve(text.slice(segStart, j), segStart, 0);
        out.push({ face, text: text.slice(j, j + 1), start: j });
        segStart = j + 1;
      }
      if (segStart < me) resolve(text.slice(segStart, me), segStart, 0);
      cursor = me;
    });
    if (cursor < text.length || out.length === 0) {
      out.push({ face, text: text.slice(cursor), start: cursor });
    }
    return out;
  }

  private ftHandle(key: string): bigint {
    let h = this.handles.get(key);
    if (h !== undefined) return h;
    const def = this.faces.get(key);
    if (!def) log.warn("run-cache", `unregistered face ${key}`);
    h = def ? this.ft.face(def.path) : 0n;
    this.handles.set(key, h);
    return h;
  }

  private touch(k: string): void {
    this.lru.set(k, ++this.tick);
  }

  private calibrate(face: string, sizePx: number): number {
    const ck = `${face}@${sizePx}`;
    const cached = this.baselines.get(ck);
    if (cached !== undefined) return cached;
    let baseline = Math.round(sizePx * 0.8);
    const probe = this.ft.render(this.ftHandle(face), "H", sizePx);
    if (probe) {
      // Bottom-most ink row = baseline (glyphs sit on it).
      outer:
      for (let y = probe.height - 1; y >= 0; y--) {
        for (let x = 0; x < probe.width; x++) {
          if (probe.data[(y * probe.width + x) * 4 + 3]! > 0) {
            baseline = y + 1;
            break outer;
          }
        }
      }
    }
    this.baselines.set(ck, baseline);
    return baseline;
  }

  /** Shape metrics for a full run. */
  getRun(face: string, sizePx: number, text: string): RunShape | null {
    if (!text) return null;
    // See getChunk — never cache results for unregistered faces.
    if (!this.faces.has(face)) return null;
    const size = Math.max(1, Math.round(sizePx));
    const ck = `r|${face}@${size}\x00${text}`;
    const hit = this.runs.get(ck);
    if (hit) { this.touch(ck); return hit; }
    if (!this.ready) return null;

    const shaped = this.shaper.shape(face, text, size);
    const m = this.shaper.metrics(face, size);
    const advance = shaped?.advance ?? Math.max(0, this.ft.measure(this.ftHandle(face), text, size));
    const shape: RunShape = {
      advance,
      clusterOffsets: shaped?.clusterOffsets ?? monotonicOffsets(text.length),
      ascent: m.ascent,
      descent: m.descent,
      baselineInBitmap: this.calibrate(face, size),
    };
    this.runs.set(ck, shape);
    this.touch(ck);
    this.evictIfNeeded();
    return shape;
  }

  /** Rasterized atlas bitmap for a substring (or full run). */
  getChunk(face: string, sizePx: number, text: string): ChunkBitmap | null {
    if (!text) return null;
    // Unregistered face — return null WITHOUT caching: during boot there's a
    // window where the shaper is ready but loadFaces() hasn't finished, and a
    // cached empty chunk here would poison the face for the whole session.
    if (!this.faces.has(face)) return null;
    const size = Math.max(1, Math.round(sizePx));
    const ck = `c|${face}@${size}\x00${text}`;
    const hit = this.chunks.get(ck);
    if (hit) {
      if (hit.region && hit.region.generation !== this.atlas.generation) {
        this.chunks.delete(ck);
      } else {
        this.touch(ck);
        return hit;
      }
    }
    if (!this.ready) return null;

    const baseline = this.calibrate(face, size);
    const rs = this.faces.get(face)!.rasterScale ?? 1;
    // CBDT color strike — compose embedded PNGs at native strike resolution;
    // the GPU stretch down to logical draw size is the antialiasing.
    const cbdt = this.cbdtFor(face);
    const colorBmp = cbdt ? this.renderCbdt(cbdt, face, size, text) : null;
    let bmp = colorBmp?.bmp ?? null;
    let color = !!colorBmp;
    let drawW = colorBmp?.drawW ?? 0;
    let drawH = colorBmp?.drawH ?? 0;
    let baselineInBitmap = colorBmp?.baselineInBitmap ?? baseline;
    if (!bmp) {
      color = false;
      bmp = this.ft.render(this.ftHandle(face), text, size * rs);
      if (bmp && rs > 1) bmp = downscaleBitmap(bmp, rs);
      if (bmp) { drawW = bmp.width; drawH = bmp.height; }
      baselineInBitmap = baseline;
    }
    if (!bmp || bmp.width === 0 || bmp.height === 0) {
      const empty: ChunkBitmap = { region: null, inkX: 0, w: 0, h: 0, baselineInBitmap: baseline };
      this.chunks.set(ck, empty);
      this.touch(ck);
      return empty;
    }
    let region = this.atlas.alloc(bmp.width, bmp.height);
    if (!region) {
      this.atlas.reset();
      region = this.atlas.alloc(bmp.width, bmp.height);
      if (!region) {
        log.warn("run-cache", `chunk too large for atlas: ${bmp.width}x${bmp.height}`);
        return null;
      }
    }
    this.atlas.upload(region, bmp.data);
    const chunk: ChunkBitmap = {
      region,
      inkX: color ? 0 : inkMinX(this.shaper, face, size, text),
      w: drawW,
      h: drawH,
      baselineInBitmap,
      color,
    };
    this.chunks.set(ck, chunk);
    this.touch(ck);
    this.evictIfNeeded();
    return chunk;
  }

  /** Parsed CBDT tables for `face` — null when the font has no color bitmap
   *  strike. */
  private cbdtFor(face: string): CbdtFont | null {
    if (!this.cbdtFaces.has(face)) {
      const def = this.faces.get(face);
      this.cbdtFaces.set(face, def ? CbdtFont.parse(def.data) : null);
    }
    return this.cbdtFaces.get(face) ?? null;
  }

  /** Decoded PNG pixels for one CBDT glyph — decoded strikes are size-
   *  independent, so they're cached per (face, gid) outside the chunk cache. */
  private cbdtGlyphImage(face: string, gid: number, png: Uint8Array): { data: Uint8Array; width: number; height: number } | null {
    const key = `${face}#${gid}`;
    if (this.cbdtGlyphs.has(key)) return this.cbdtGlyphs.get(key)!;
    if (this.cbdtGlyphs.size > 512) this.cbdtGlyphs.clear();
    const img = this.imgDec.available ? this.imgDec.decode(png) : null;
    this.cbdtGlyphs.set(key, img);
    return img;
  }

  /** Compose a color-bitmap strike for `text` at NATIVE strike resolution.
   *  Returns null when any glyph lacks a CBDT record — the caller then falls
   *  back to the coverage raster (silhouette) so nothing goes missing. */
  private renderCbdt(cbdt: CbdtFont, face: string, size: number, text: string)
    : { bmp: { data: Uint8Array; width: number; height: number }; drawW: number; drawH: number; baselineInBitmap: number } | null {
    const shaped = this.shaper.shapeGlyphs(face, text, size);
    if (!shaped || shaped.glyphs.length === 0) return null;
    const m = this.shaper.metrics(face, size);
    const lineH = Math.ceil(size * 1.2);
    const s = cbdt.ppem / size; // logical px → strike px
    const canvasW = Math.min(4096, Math.max(1, Math.ceil(shaped.advance * s) + 8));
    const canvasH = Math.max(1, Math.ceil(lineH * s));
    if (canvasW <= 0 || shaped.advance * s > canvasW) return null;
    const out = new Uint8Array(canvasW * canvasH * 4);
    const baselineNat = Math.round(m.ascent * s);
    let drew = 0;
    shaped.glyphs.forEach(g => {
      const rec = cbdt.glyph(g.glyphId);
      if (!rec) return;
      const img = this.cbdtGlyphImage(face, g.glyphId, rec.png);
      if (!img) return;
      const dx = Math.round(g.penX * s + rec.bearingX);
      const dy = baselineNat - rec.bearingY;
      for (let y = 0; y < img.height; y++) {
        const py = dy + y;
        if (py < 0 || py >= canvasH) continue;
        for (let x = 0; x < img.width; x++) {
          const px = dx + x;
          if (px < 0 || px >= canvasW) continue;
          const si = (y * img.width + x) * 4;
          const di = (py * canvasW + px) * 4;
          out[di] = img.data[si]!; out[di + 1] = img.data[si + 1]!;
          out[di + 2] = img.data[si + 2]!; out[di + 3] = img.data[si + 3]!;
        }
      }
      drew++;
    });
    // Missing glyphs just don't paint — their advance still lands correctly.
    if (!drew) return null;
    return {
      bmp: { data: out, width: canvasW, height: canvasH },
      drawW: shaped.advance,
      drawH: lineH,
      baselineInBitmap: m.ascent,
    };
  }

  /** Cap cache growth — drop least-recently-used entries. */
  private evictIfNeeded(): void {
    const LIMIT = 4096;
    if (this.runs.size + this.chunks.size <= LIMIT) return;
    const entries = [...this.lru.entries()].sort((a, b) => a[1] - b[1]);
    const drop = Math.floor(LIMIT / 4);
    for (let i = 0; i < drop && i < entries.length; i++) {
      const k = entries[i]![0];
      this.runs.delete(k);
      this.chunks.delete(k);
      this.missCache.delete(k);
      this.lru.delete(k);
    }
  }

  get stats(): { runs: number; chunks: number } {
    return { runs: this.runs.size, chunks: this.chunks.size };
  }

  dispose(): void {
    this.runs.clear();
    this.chunks.clear();
    this.missCache.clear();
    this.baselines.clear();
    this.lru.clear();
    this.ft.dispose();
    this.shaper.dispose();
  }
}

/** Box-filter downscale of a premultiplied coverage RGBA bitmap. */
function downscaleBitmap(bmp: { data: Uint8Array; width: number; height: number }, factor: number): { data: Uint8Array; width: number; height: number } {
  const w = Math.floor(bmp.width / factor);
  const h = Math.floor(bmp.height / factor);
  if (w <= 0 || h <= 0) return bmp;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const i = ((y * factor + dy) * bmp.width + (x * factor + dx)) * 4;
          r += bmp.data[i]!; g += bmp.data[i + 1]!; b += bmp.data[i + 2]!; a += bmp.data[i + 3]!;
        }
      }
      const n = factor * factor;
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { data: out, width: w, height: h };
}

function monotonicOffsets(len: number): Float32Array {
  const o = new Float32Array(len + 1);
  for (let i = 0; i <= len; i++) o[i] = i;
  return o;
}

/** Left ink edge of a substring in pen space. Negative = overhang left of
 *  the pen origin (italic f, quotes). Derived from hb glyph extents. */
function inkMinX(shaper: TextShaper, face: string, sizePx: number, text: string): number {
  const f = shaper.font(face);
  if (!f) return 0;
  const shaped = shaper.shapeGlyphs(face, text, sizePx);
  if (!shaped || shaped.glyphs.length === 0) return 0;
  f.font.setScale(sizePx, sizePx);
  let minX = Infinity;
  for (const g of shaped.glyphs) {
    const ext = f.font.glyphExtents(g.glyphId);
    if (ext) minX = Math.min(minX, g.penX + ext.xBearing);
  }
  return minX === Infinity ? 0 : minX;
}
