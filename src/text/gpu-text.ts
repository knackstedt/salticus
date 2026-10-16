// ============================================================================
// gpu-text.ts — instanced quad renderer for the editor surface.
//
// Owns the WGSL pipeline (text.wgsl), a growable instance buffer, the run
// atlas, and a per-frame quad batch. Surfaces call draw*() during their
// frame pass; render() flushes the batch into the open UI render pass.
//
// All coordinates are surface pixels, y-down. Output premultiplied alpha.
// ============================================================================

import shaderSource from "./text.wgsl?raw" with { type: "text" };
import { TextAtlas, type AtlasRegion } from "./atlas";

export const KIND_TEXT = 0;
export const KIND_RECT = 1;
export const KIND_ROUNDED = 2;

const FLOATS_PER_INSTANCE = 16; // 4 × vec4f
const INITIAL_CAPACITY = 2048;

export type Rgba = [number, number, number, number];

export interface RunQuadSrc {
  region: AtlasRegion;
  atlasSize: number;
}

export class GpuTextPass {
  private pipeline: GPURenderPipeline;
  private uniformBuf: GPUBuffer;
  private instanceBuf: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout;
  private sampler: GPUSampler;
  private data = new Float32Array(INITIAL_CAPACITY * FLOATS_PER_INSTANCE);
  private count = 0;
  private bindGroup: GPUBindGroup | null = null;
  private boundAtlas: TextAtlas | null = null;

  constructor(readonly device: GPUDevice, format: GPUTextureFormat) {
    const module = device.createShaderModule({ label: "text", code: shaderSource });
    this.bindGroupLayout = device.createBindGroupLayout({
      label: "text-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    this.pipeline = device.createRenderPipeline({
      label: "text",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [{
          format,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });
    this.uniformBuf = device.createBuffer({
      label: "text-uniforms",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.instanceBuf = device.createBuffer({
      label: "text-instances",
      size: this.data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });
  }

  begin(): void {
    this.count = 0;
  }

  private push(): number {
    if (this.count >= this.data.length / FLOATS_PER_INSTANCE) {
      const bigger = new Float32Array(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
      const old = this.instanceBuf;
      this.instanceBuf = this.device.createBuffer({
        label: "text-instances",
        size: bigger.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.bindGroup = null;
      old.destroy();
    }
    return this.count++ * FLOATS_PER_INSTANCE;
  }

  private quad(dst: [number, number, number, number], src: [number, number, number, number],
    color: Rgba, aux: [number, number, number, number]): void {
    const o = this.push();
    const d = this.data;
    d[o] = dst[0]; d[o + 1] = dst[1]; d[o + 2] = dst[2]; d[o + 3] = dst[3];
    d[o + 4] = src[0]; d[o + 5] = src[1]; d[o + 6] = src[2]; d[o + 7] = src[3];
    d[o + 8] = color[0]; d[o + 9] = color[1]; d[o + 10] = color[2]; d[o + 11] = color[3];
    d[o + 12] = aux[0]; d[o + 13] = aux[1]; d[o + 14] = aux[2]; d[o + 15] = aux[3];
  }

  /** Draw a coverage-atlas run quad. */
  text(x: number, y: number, w: number, h: number, src: RunQuadSrc, color: Rgba): void {
    const s = src.atlasSize;
    this.quad([x, y, w, h],
      [src.region.u / s, src.region.v / s, (src.region.u + src.region.w) / s, (src.region.v + src.region.h) / s],
      color, [KIND_TEXT, 0, 0, 0]);
  }

  /** Solid rectangle — selections, carets, rules, underlines. */
  rect(x: number, y: number, w: number, h: number, color: Rgba): void {
    this.quad([x, y, w, h], [0, 0, 0, 0], color, [KIND_RECT, 0, 0, 0]);
  }

  /** Rounded rectangle — code spans, chips, block backgrounds. */
  roundedRect(x: number, y: number, w: number, h: number, radius: number, color: Rgba): void {
    this.quad([x, y, w, h], [0, 0, 0, 0], color, [KIND_ROUNDED, radius, 0, 0]);
  }

  get quadCount(): number {
    return this.count;
  }

  /** Record the batch into the open UI render pass. */
  render(pass: GPURenderPassEncoder, surfaceW: number, surfaceH: number,
    atlas: TextAtlas, time: number): void {
    if (this.count === 0) return;
    if (this.boundAtlas !== atlas) {
      this.boundAtlas = atlas;
      this.bindGroup = null;
    }
    if (!this.bindGroup) {
      this.bindGroup = this.device.createBindGroup({
        label: "text-bg",
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuf } },
          { binding: 1, resource: { buffer: this.instanceBuf } },
          { binding: 2, resource: atlas.view },
          { binding: 3, resource: this.sampler },
        ],
      });
    }
    this.device.queue.writeBuffer(this.uniformBuf, 0, new Float32Array([surfaceW, surfaceH, time, 0]));
    this.device.queue.writeBuffer(this.instanceBuf, 0, this.data, 0, this.count * FLOATS_PER_INSTANCE);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(6, this.count);
  }

  destroy(): void {
    this.instanceBuf.destroy();
    this.uniformBuf.destroy();
  }
}
