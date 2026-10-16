// ============================================================================
// ft.ts — multi-face text run rasterizer over the platform's cosmic-text FFI.
//
// libdowndraft_platform exports ft_shim_* (cosmic-text: rustybuzz shaping +
// swash rasterization). Each handle owns a FontSystem with a single font —
// we keep one handle per (family, weight, style) face file.
//
// Wire contract (native-rs/src/text.rs):
//   ft_shim_init(font_path)                       → i64 handle (0 on failure)
//   ft_shim_render_text(h, text, size, out, out_size, max_w, max_h, w_out, h_out)
//                                                 → i32 bytes written
//     out = premultiplied coverage RGBA (cov,cov,cov,cov), dims clamped
//   ft_shim_measure(h, text, size)                → i32 advance px
//   ft_shim_done(h)                               → void
// ============================================================================

import { dlopen, ptr, resolvePlatformLibrary } from "@downdraft/platform-native";
import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger();

const FT_SPEC = {
  ft_shim_init: { args: ["cstring"], returns: "i64" },
  ft_shim_render_text: {
    args: ["i64", "cstring", "i32", "ptr", "i32", "i32", "i32", "ptr", "ptr"],
    returns: "i32",
  },
  ft_shim_measure: { args: ["i64", "cstring", "i32"], returns: "i32" },
  ft_shim_done: { args: ["i64"], returns: "void" },
} as const;

type FtSymbols = Record<keyof typeof FT_SPEC, (...args: never[]) => number | bigint | void>;

export interface FtRunBitmap {
  /** Premultiplied coverage RGBA — every texel is (cov,cov,cov,cov). */
  data: Uint8Array;
  width: number;
  height: number;
}

const MAX_W = 4096;
const MAX_H = 256;
const RENDER_BUF = new Uint8Array(MAX_W * MAX_H * 4);
const DIMS_OUT = new Int32Array(2);

export class FtRasterizer {
  private symbols: FtSymbols | null = null;
  private faces = new Map<string, bigint>();

  constructor() {
    try {
      const libPath = resolvePlatformLibrary(true);
      if (!libPath) {
        log.warn("ft", "platform library not found — text rasterization unavailable");
        return;
      }
      this.symbols = dlopen(libPath, FT_SPEC).symbols as unknown as FtSymbols;
    } catch (e) {
      log.warn("ft", `platform dlopen failed: ${e}`);
    }
  }

  get available(): boolean {
    return this.symbols !== null;
  }

  /** Load (or get) a face handle for a font file path. */
  face(path: string): bigint {
    const existing = this.faces.get(path);
    if (existing !== undefined) return existing;
    if (!this.symbols) return 0n;
    const h = this.symbols.ft_shim_init(path) as unknown as bigint;
    if (h === 0n) log.warn("ft", `ft_shim_init failed for ${path}`);
    this.faces.set(path, h);
    return h;
  }

  /** Rasterize a text run at pixel size. Returns premultiplied coverage RGBA.
   *  Long runs are clipped at MAX_W — callers should chunk first. */
  render(handle: bigint, text: string, sizePx: number): FtRunBitmap | null {
    if (!this.symbols || handle === 0n || !text) return null;
    const n = this.symbols.ft_shim_render_text(
      handle, text, Math.max(1, Math.round(sizePx)),
      ptr(RENDER_BUF) as never, RENDER_BUF.length,
      MAX_W, MAX_H,
      ptr(DIMS_OUT) as never, ptr(DIMS_OUT.subarray(1)) as never,
    ) as unknown as number;
    if (n <= 0) return null;
    const w = DIMS_OUT[0]!;
    const h = DIMS_OUT[1]!;
    if (w <= 0 || h <= 0) return null;
    const data = new Uint8Array(w * h * 4);
    data.set(RENDER_BUF.subarray(0, w * h * 4));
    return { data, width: w, height: h };
  }

  /** Advance width of a run at pixel size (-1 on failure). */
  measure(handle: bigint, text: string, sizePx: number): number {
    if (!this.symbols || handle === 0n || !text) return -1;
    return this.symbols.ft_shim_measure(handle, text, Math.max(1, Math.round(sizePx))) as unknown as number;
  }

  dispose(): void {
    if (!this.symbols) return;
    this.faces.forEach((h) => {
      try { this.symbols!.ft_shim_done(h as never); } catch { /* shutdown */ }
    });
    this.faces.clear();
  }
}
