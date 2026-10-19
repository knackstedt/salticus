// ============================================================================
// wb/raster.ts — RGBA crop + minimal single-image PDF wrap.
// PNG encoding uses @downdraft/platform-native (see surface.ts exportWb).
// ============================================================================

import { deflateSync } from "node:zlib";

export interface Rgba { w: number; h: number; data: Uint8Array }

/** Crop RGBA pixels to a rect (clamped to bounds). */
export function cropRgba(img: Rgba, x: number, y: number, w: number, h: number): Rgba {
  const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(img.w, Math.round(x + w)), y1 = Math.min(img.h, Math.round(y + h));
  const cw = Math.max(1, x1 - x0), chh = Math.max(1, y1 - y0);
  const out = new Uint8Array(cw * chh * 4);
  for (let r = 0; r < chh; r++) {
    out.set(img.data.subarray(((y0 + r) * img.w + x0) * 4, ((y0 + r) * img.w + x0 + cw) * 4), r * cw * 4);
  }
  return { w: cw, h: chh, data: out };
}

/** Minimal single-page PDF embedding an RGBA image (FlateDecode, RGB). */
export function pdfFromRgba(img: Rgba): Uint8Array {
  const enc = new TextEncoder();
  const rgb = new Uint8Array(img.w * img.h * 3);
  for (let i = 0, j = 0; i < img.data.length; i += 4, j += 3) {
    rgb[j] = img.data[i]!; rgb[j + 1] = img.data[i + 1]!; rgb[j + 2] = img.data[i + 2]!;
  }
  const imgData = deflateSync(rgb, { level: 6 });
  const stream5 = `q\n${img.w} 0 0 ${img.h} 0 0 cm\n/Im0 Do\nQ\n`;
  // Object bodies; the image object is three parts (dict + data + tail) but
  // contributes a single xref offset — so build them as [start?, bytes] runs.
  const objs: Uint8Array[] = [
    enc.encode(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`),
    enc.encode(`2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`),
    enc.encode(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${img.w} ${img.h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`),
    enc.encode(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${imgData.length} >>\nstream\n`),
    new Uint8Array(imgData),
    enc.encode(`\nendstream\nendobj\n`),
    enc.encode(`5 0 obj\n<< /Length ${enc.encode(stream5).length} >>\nstream\n${stream5}endstream\nendobj\n`),
  ];
  // Indices into `objs` where numbered objects start.
  const objStarts = [0, 1, 2, 3, 6];
  const head = enc.encode("%PDF-1.4\n");
  const parts: Uint8Array[] = [head];
  const offsets: number[] = [];
  let pos = head.length;
  objs.forEach((o, i) => {
    if (objStarts.includes(i)) offsets.push(pos);
    parts.push(o); pos += o.length;
  });
  const xrefPos = pos;
  const xref = [`xref\n0 6\n0000000000 65535 f \n`];
  offsets.forEach(o => xref.push(`${String(o).padStart(10, "0")} 00000 n \n`));
  parts.push(enc.encode(xref.join("") + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o2 = 0;
  parts.forEach(p => { out.set(p, o2); o2 += p.length; });
  return out;
}
