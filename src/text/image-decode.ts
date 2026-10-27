// ============================================================================
// image-decode.ts — PNG decode via the platform's image_shim_decode FFI
// (Rust `image` crate). Used by the CBDT color-emoji path to turn embedded
// PNG strikes into RGBA pixels, and by the whiteboard image assets.
// ============================================================================

import { dlopen, ptr, resolvePlatformLibrary } from "@downdraft/platform-native";
import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger();

const IMG_SPEC = {
  image_shim_decode: { args: ["ptr", "i32", "ptr", "i32", "ptr", "ptr", "ptr"], returns: "i32" },
  image_shim_info: { args: ["ptr", "i32", "ptr", "ptr", "ptr"], returns: "i32" },
} as const;

type ImgSymbols = {
  image_shim_decode: (...args: never[]) => number;
  image_shim_info: (...args: never[]) => number;
};

export interface DecodedImage {
  /** Straight-alpha RGBA8. */
  data: Uint8Array;
  width: number;
  height: number;
}

export interface ImageInfo {
  width: number;
  height: number;
  channels: number;
}

const DIMS = new Int32Array(3);
let inBuf = new Uint8Array(1024 * 1024);
let outBuf = new Uint8Array(4 * 1024 * 1024);

export class ImageDecoder {
  private symbols: ImgSymbols | null = null;

  constructor() {
    try {
      const libPath = resolvePlatformLibrary(true);
      if (libPath) this.symbols = dlopen(libPath, IMG_SPEC).symbols as unknown as ImgSymbols;
    } catch (e) {
      log.warn("image-decode", `platform dlopen failed: ${e}`);
    }
  }

  get available(): boolean {
    return this.symbols !== null;
  }

  /** Header probe: dims + channel count without decoding pixels. */
  info(png: Uint8Array): ImageInfo | null {
    if (!this.symbols || png.length === 0) return null;
    if (inBuf.length < png.length) inBuf = new Uint8Array(png.length);
    inBuf.set(png);
    const rc = this.symbols.image_shim_info(
      ptr(inBuf) as never, png.length,
      ptr(DIMENS()) as never, ptr(DIMENS(1)) as never, ptr(DIMENS(2)) as never,
    );
    if (rc !== 0) return null;
    const [w, h, ch] = [DIMS[0]!, DIMS[1]!, DIMS[2]!];
    return w > 0 && h > 0 ? { width: w, height: h, channels: ch } : null;
  }

  /** Decode image bytes → straight-alpha RGBA8, or null on failure. The
   *  output buffer grows to fit — no fixed cap. */
  decode(png: Uint8Array): DecodedImage | null {
    const d = this.info(png);
    if (!d || !this.symbols) return null;
    const need = d.width * d.height * 4;
    if (outBuf.length < need) outBuf = new Uint8Array(need);
    const rc = this.symbols.image_shim_decode(
      ptr(inBuf) as never, png.length,
      ptr(outBuf) as never, outBuf.length,
      ptr(DIMENS()) as never, ptr(DIMENS(1)) as never, ptr(DIMENS(2)) as never,
    );
    if (rc !== 0) return null;
    const [w, h, ch] = [DIMS[0]!, DIMS[1]!, DIMS[2]!];
    if (w <= 0 || h <= 0 || ch !== 4 || w * h * 4 > outBuf.length) return null;
    const data = new Uint8Array(w * h * 4);
    data.set(outBuf.subarray(0, w * h * 4));
    return { data, width: w, height: h };
  }
}

function DIMENS(i = 0): Int32Array {
  return DIMS.subarray(i, i + 1);
}
