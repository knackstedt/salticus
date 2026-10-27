// ============================================================================
// assets.ts — raster asset store for whiteboard image items.
//
// PNG bytes live content-addressed at <workspace>/assets/<id>.png; items keep
// the id in `asset`. WbImageCache decodes on demand into a dedicated atlas
// (separate from the glyph atlas so large photos don't evict text runs);
// regions re-upload after atlas resets.
// ============================================================================

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@downdraft/engine/util/logger";
import type { TextAtlas, AtlasRegion } from "../text/atlas";
import { ImageDecoder } from "../text/image-decode";
import { workspaceDir } from "../app/workspace";

const log = createLogger();

export function assetsDir(): string {
  return join(workspaceDir(), "assets");
}

export function assetPath(id: string): string {
  return join(assetsDir(), `${id}.png`);
}

/** Persist PNG bytes; returns the content-addressed asset id. */
export function saveAsset(png: Uint8Array): string {
  const id = createHash("sha256").update(png).digest("hex").slice(0, 24);
  const path = assetPath(id);
  if (!existsSync(path)) {
    mkdirSync(assetsDir(), { recursive: true });
    writeFileSync(path, png);
  }
  return id;
}

export function loadAsset(id: string): Uint8Array | null {
  try {
    return new Uint8Array(readFileSync(assetPath(id)));
  } catch {
    return null;
  }
}

export function loadAssetBase64(id: string): string | null {
  try {
    return readFileSync(assetPath(id)).toString("base64");
  } catch {
    return null;
  }
}

/** Longest-side cap so a single image can't crowd out the atlas. */
const MAX_DIM = 1024;
/** Decoded-entry bound — each entry is ≤ MAX_DIM² × 4B (~4MB). */
const MAX_ENTRIES = 48;

interface Entry {
  rgba: Uint8Array;
  w: number;
  h: number;
  region: AtlasRegion | null;
}

/** Integer-factor box downscale to ≤ MAX_DIM (straight alpha). */
function downscale(data: Uint8Array, w: number, h: number): { rgba: Uint8Array; w: number; h: number } {
  const f = Math.ceil(Math.max(w, h) / MAX_DIM);
  if (f <= 1) return { rgba: data, w, h };
  const nw = Math.max(1, Math.floor(w / f));
  const nh = Math.max(1, Math.floor(h / f));
  const out = new Uint8Array(nw * nh * 4);
  const n = f * f;
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < f; dy++) {
        const row = (y * f + dy) * w;
        for (let dx = 0; dx < f; dx++) {
          const i = (row + x * f + dx) * 4;
          r += data[i]!; g += data[i + 1]!; b += data[i + 2]!; a += data[i + 3]!;
        }
      }
      const o = (y * nw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { rgba: out, w: nw, h: nh };
}

export class WbImageCache {
  private decoder = new ImageDecoder();
  /** insertion-ordered; null = failed decode (don't retry every frame). */
  private entries = new Map<string, Entry | null>();

  constructor(private atlas: TextAtlas) {}

  /** Atlas region for an asset, decoding/uploading on demand. */
  getRegion(asset: string): { region: AtlasRegion; atlas: TextAtlas } | null {
    if (!asset) return null;
    let e = this.entries.get(asset);
    if (e === undefined) {
      e = this.decodeAsset(asset);
      this.entries.set(asset, e);
      while (this.entries.size > MAX_ENTRIES) {
        const oldest = this.entries.keys().next().value!;
        this.entries.delete(oldest);
      }
    } else {
      // Refresh LRU position.
      this.entries.delete(asset);
      this.entries.set(asset, e);
    }
    if (!e) return null;
    if (e.region && e.region.generation === this.atlas.generation) {
      return { region: e.region, atlas: this.atlas };
    }
    let region = this.atlas.alloc(e.w, e.h);
    if (!region) {
      this.atlas.reset();
      region = this.atlas.alloc(e.w, e.h);
      if (!region) return null;
    }
    this.atlas.upload(region, e.rgba);
    e.region = region;
    return { region, atlas: this.atlas };
  }

  private decodeAsset(asset: string): Entry | null {
    const png = loadAsset(asset);
    if (!png || !this.decoder.available) return null;
    const d = this.decoder.decode(png);
    if (!d) return null;
    const s = downscale(d.data, d.width, d.height);
    if (s.w !== d.width || s.h !== d.height) {
      log.info("wb-assets", `downscaled ${asset} ${d.width}x${d.height} → ${s.w}x${s.h}`);
    }
    return { rgba: s.rgba, w: s.w, h: s.h, region: null };
  }
}
