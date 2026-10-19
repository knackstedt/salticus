// ============================================================================
// cbdt.ts — minimal CBDT/CBLC (color bitmap emoji) parser.
//
// Google's CBDT format embeds PNG bitmaps per glyph id: CBLC locates image
// records per gid range; CBDT holds the PNG payload + glyph metrics. We only
// implement what Noto Color Emoji uses: indexSubTable format 1 and image
// formats 17 (small metrics) / 18 (+ length) / 19 (big metrics).
// ============================================================================

export interface CbdtGlyph {
  /** PNG bytes for this glyph's bitmap strike. */
  png: Uint8Array;
  width: number;
  height: number;
  /** Horizontal distance from pen origin to the bitmap's left edge. */
  bearingX: number;
  /** Vertical distance from baseline UP to the bitmap's top edge. */
  bearingY: number;
  /** Advance in strike pixels. */
  advance: number;
}

interface IndexSubtable {
  firstGlyph: number;
  lastGlyph: number;
  /** Absolute offset (into the font file) of the indexSubTable. */
  tableOffset: number;
}

export class CbdtFont {
  /** Strike pixels-per-em (y) — the bitmap's native em size. */
  readonly ppem: number;

  private u16: (o: number) => number;
  private u32: (o: number) => number;
  private i8: (o: number) => number;
  private u8: (o: number) => number;
  private subs: IndexSubtable[] = [];
  private arrayStart = 0;
  private cbdtStart = 0;
  private cbdtEnd = 0;

  static parse(data: Uint8Array): CbdtFont | null {
    try {
      const f = new CbdtFont(data);
      return f.subs.length ? f : null;
    } catch {
      return null;
    }
  }

  private constructor(private data: Uint8Array) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.u16 = o => dv.getUint16(o);
    this.u32 = o => dv.getUint32(o);
    this.i8 = o => dv.getInt8(o);
    this.u8 = o => dv.getUint8(o);

    // SFNT table directory.
    const numTables = this.u16(4);
    let cblc = -1, cbdt = -1;
    for (let i = 0; i < numTables; i++) {
      const o = 12 + i * 16;
      const tag = String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
      if (tag === "CBLC") cblc = this.u32(o + 8);
      else if (tag === "CBDT") { cbdt = this.u32(o + 8); this.cbdtEnd = cbdt + this.u32(o + 12); }
    }
    if (cblc < 0 || cbdt < 0) { this.ppem = 0; return; }
    this.cbdtStart = cbdt;

    // CBLC header — pick the first strike (Noto Color Emoji ships exactly one).
    const numSizes = this.u32(cblc + 4);
    if (numSizes <= 0) { this.ppem = 0; return; }
    const st = cblc + 8; // first bitmapSizeTable
    this.ppem = this.u8(st + 45); // ppemY
    const arrayOff = this.u32(st + 0);
    const numSubs = this.u32(st + 8);
    this.arrayStart = cblc + arrayOff;
    for (let i = 0; i < numSubs; i++) {
      const e = this.arrayStart + i * 8;
      this.subs.push({
        firstGlyph: this.u16(e),
        lastGlyph: this.u16(e + 2),
        tableOffset: this.arrayStart + this.u32(e + 4),
      });
    }
  }

  /** Glyph bitmap for `gid`, or null when the strike has no record. */
  glyph(gid: number): CbdtGlyph | null {
    const sub = this.subs.find(s => gid >= s.firstGlyph && gid <= s.lastGlyph);
    if (!sub) return null;
    const t = sub.tableOffset;
    const indexFormat = this.u16(t);
    const imageFormat = this.u16(t + 2);
    if (indexFormat !== 1) return null; // fmt 2/3 (fixed-size) unused by Noto
    const imageDataOff = this.u32(t + 4);
    const idx = gid - sub.firstGlyph;
    const e0 = t + 8 + idx * 4;
    const recOff = this.u32(e0);
    const recLen = this.u32(e0 + 4) - recOff;
    if (recLen <= 0) return null;
    const rec = this.cbdtStart + imageDataOff + recOff;
    if (rec < this.cbdtStart || rec + recLen > this.cbdtEnd) return null;

    // CBDT image formats: 17 = smallGlyphMetrics + dataSize + PNG;
    // 18 = bigGlyphMetrics + dataSize + PNG. (Unlike EBDT, CBDT records
    // always carry the uint32 dataSize — Noto's fmt17 has it.)
    if (imageFormat === 17 || imageFormat === 18) {
      const metricsLen = imageFormat === 17 ? 5 : 11;
      const height = this.u8(rec), width = this.u8(rec + 1);
      const bearingX = this.i8(rec + 2), bearingY = this.i8(rec + 3);
      const advance = this.u8(rec + 4);
      const pngOff = rec + metricsLen + 4;
      const pngLen = this.u32(rec + metricsLen);
      if (pngLen <= 0 || pngOff + pngLen > rec + recLen) return null;
      return { png: this.data.subarray(pngOff, pngOff + pngLen), width, height, bearingX, bearingY, advance };
    }
    if (imageFormat === 19) {
      const height = this.u8(rec), width = this.u8(rec + 1);
      const bearingX = this.i8(rec + 2), bearingY = this.i8(rec + 3);
      const advance = this.u8(rec + 4);
      const pngOff = rec + 15;
      const pngLen = this.u32(rec + 11);
      if (pngLen <= 0 || pngOff + pngLen > rec + recLen) return null;
      return { png: this.data.subarray(pngOff, pngOff + pngLen), width, height, bearingX, bearingY, advance };
    }
    return null;
  }
}
