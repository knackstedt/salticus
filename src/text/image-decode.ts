// ============================================================================
// image-decode.ts — PNG decode via the platform's image_shim_decode FFI
// (Rust `image` crate). Used by the CBDT color-emoji path to turn embedded
// PNG strikes into RGBA pixels.
// ============================================================================

import { dlopen, ptr, resolvePlatformLibrary } from "@downdraft/platform-native";
import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger();

const IMG_SPEC = {
  image_shim_decode: { args: ["ptr", "i32", "ptr", "i32", "ptr", "ptr", "ptr"], returns: "i32" },
} as const;

type ImgSymbols = { image_shim_decode: (...args: never[]) => number };

export interface DecodedImage {
  /** Straight-alpha RGBA8. */
  data: Uint8Array;
  width: number;
  height: number;
}

const OUT = new Uint8Array(1024 * 1024 * 4);
const DIMS = new Int32Array(3);
const pngBuf = new Uint8Array(1024 * 1024);

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

  /** Decode PNG bytes → straight-alpha RGBA8, or null on failure/oversize. */
  decode(png: Uint8Array): DecodedImage | null {
    if (!this.symbols || png.length === 0 || png.length > pngBuf.length) return null;
    pngBuf.set(png);
    const rc = this.symbols.image_shim_decode(
      ptr(pngBuf) as never, png.length,
      ptr(OUT) as never, OUT.length,
      ptr(DIMENS()) as never, ptr(DIMENS(1)) as never, ptr(DIMENS(2)) as never,
    );
    if (rc !== 0) return null;
    const [w, h, ch] = [DIMS[0]!, DIMS[1]!, DIMS[2]!];
    if (w <= 0 || h <= 0 || ch !== 4 || w * h * 4 > OUT.length) return null;
    const data = new Uint8Array(w * h * 4);
    data.set(OUT.subarray(0, w * h * 4));
    return { data, width: w, height: h };
  }
}

function DIMENS(i = 0): Int32Array {
  return DIMS.subarray(i, i + 1);
}
