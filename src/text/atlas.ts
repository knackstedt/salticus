// ============================================================================
// atlas.ts — shelf-packed coverage atlas for rasterized text runs.
//
// One rgba8unorm texture; runs upload their premultiplied coverage bitmap
// into a region. Eviction is generational: when the atlas fills, `reset()`
// bumps `generation` and all cached regions invalidate (callers re-rasterize
// on demand — run rasterization is ~100µs).
// ============================================================================

interface Shelf {
  y: number;
  h: number;
  x: number;
}

export interface AtlasRegion {
  u: number;
  v: number;
  w: number;
  h: number;
  generation: number;
}

export class TextAtlas {
  readonly size: number;
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  generation = 0;
  private shelves: Shelf[] = [];
  private nextY = 0;
  private padded = new Uint8Array(0);

  constructor(readonly device: GPUDevice, size = 2048) {
    this.size = size;
    this.texture = device.createTexture({
      label: "text-atlas",
      size: { width: size, height: size },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.view = this.texture.createView();
    this.device.queue.writeTexture(
      { texture: this.texture },
      new Uint8Array(size * size * 4),
      { bytesPerRow: size * 4 },
      { width: size, height: size },
    );
  }

  /** Allocate a texel rectangle, or null if the atlas is full. */
  alloc(w: number, h: number): AtlasRegion | null {
    if (w <= 0 || h <= 0) return null;
    // Best-fit shelf: shortest shelf that still fits the height.
    let best: Shelf | null = null;
    for (const s of this.shelves) {
      if (s.h >= h && s.x + w <= this.size) {
        if (!best || s.h < best.h) best = s;
      }
    }
    if (best) {
      const r: AtlasRegion = { u: best.x, v: best.y, w, h, generation: this.generation };
      best.x += w;
      return r;
    }
    if (this.nextY + h > this.size) return null;
    const shelf: Shelf = { y: this.nextY, h, x: w };
    this.shelves.push(shelf);
    this.nextY += h;
    return { u: 0, v: shelf.y, w, h, generation: this.generation };
  }

  /** Upload premultiplied RGBA coverage into an allocated region. */
  upload(region: AtlasRegion, data: Uint8Array): void {
    const w = region.w;
    const h = region.h;
    const bpr = Math.ceil((w * 4) / 256) * 256;
    if (bpr === w * 4) {
      this.device.queue.writeTexture(
        { texture: this.texture, origin: { x: region.u, y: region.v } },
        data,
        { bytesPerRow: w * 4 },
        { width: w, height: h },
      );
      return;
    }
    const need = bpr * h;
    if (this.padded.length < need) this.padded = new Uint8Array(need);
    this.padded.fill(0, 0, need);
    for (let row = 0; row < h; row++) {
      this.padded.set(data.subarray(row * w * 4, (row + 1) * w * 4), row * bpr);
    }
    this.device.queue.writeTexture(
      { texture: this.texture, origin: { x: region.u, y: region.v } },
      this.padded.subarray(0, need),
      { bytesPerRow: bpr },
      { width: w, height: h },
    );
  }

  /** Invalidate every region. Callers must re-rasterize on next lookup. */
  reset(): void {
    this.generation++;
    this.shelves.length = 0;
    this.nextY = 0;
  }

  destroy(): void {
    this.texture.destroy();
  }
}
