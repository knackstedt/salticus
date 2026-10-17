// ============================================================================
// thumbnails.ts — page preview thumbnails stored on disk.
//
// Captures the presented frame's content rect via the native surface's
// pre-present readback hook (same machinery as MCP screenshots), downscales
// it, encodes PNG, and writes workspace/thumbs/<id>.png. The file is also
// registered as a ui://thumb/<id> resource so chrome markup can render it
// with a plain <img>.
//
// "Store on disk, don't derive on demand": captures only happen for the
// ACTIVE page while it's on screen — a thumbnail is a snapshot of the last
// rendered state, persisted for later sessions.
// ============================================================================

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePNG } from "@downdraft/platform-native";
import { getNativeHost } from "@downdraft/engine";
import { createLogger } from "@downdraft/engine/util/logger";
import { bumpThumb, store } from "./store";
import { workspaceDir } from "./workspace";

const log = createLogger();

/** Downscaled thumb width in device px (displayed ~220 css px at scale 2). */
const THUMB_W = 440;

interface ThumbUi {
  loadResource?: (uiUrl: string, src: string | Uint8Array | ArrayBuffer) => Promise<void>;
  host?: { registerResource?: (url: string, bytes: Uint8Array | ArrayBuffer) => void };
}

let ui: ThumbUi | null = null;
const present = new Set<string>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
let inFlight: Promise<void> | null = null;

export function thumbsDir(): string {
  const d = join(workspaceDir(), "thumbs");
  mkdirSync(d, { recursive: true });
  return d;
}

export function thumbPath(id: string): string {
  return join(thumbsDir(), `${id}.png`);
}

export function thumbUrl(id: string): string {
  return `ui://thumb/${id}.png`;
}

/** Whether a thumbnail file exists for this page (drives markup emission). */
export function hasThumb(id: string): boolean {
  return present.has(id);
}

/** Stash the html-ui context so captured thumbs can be served as resources. */
export function setThumbUi(u: ThumbUi): void {
  ui = u;
}

/** Register every existing thumb file as a ui:// resource (call at boot). */
export function serveThumbs(): void {
  try {
    for (const f of readdirSync(thumbsDir())) {
      if (!f.endsWith(".png")) continue;
      const id = f.slice(0, -4);
      present.add(id);
      void ui?.loadResource?.(thumbUrl(id), readFileSync(join(thumbsDir(), f)));
    }
  } catch { /* dir may not exist yet */ }
}

export function deleteThumbFile(id: string): void {
  present.delete(id);
  try {
    const p = thumbPath(id);
    if (existsSync(p)) unlinkSync(p);
  } catch { /* best-effort */ }
}

/** Debounced capture request — fires only if `id` is still the active page
 *  when it runs (a thumbnail always depicts its own page's rendered view). */
export function requestThumb(id: string | null, delayMs = 800): void {
  if (!id) return;
  const prev = pending.get(id);
  if (prev) clearTimeout(prev);
  pending.set(id, setTimeout(() => {
    pending.delete(id);
    if (store.getState().activePageId !== id) return;
    if (!inFlight) {
      inFlight = capturePageThumb(id).finally(() => { inFlight = null; });
    } else {
      // Serialize — a second capture can start once the current one ends.
      inFlight = inFlight
        .then(() => (store.getState().activePageId === id ? capturePageThumb(id) : undefined));
    }
  }, delayMs));
}

/** Read back the next presented frame, crop the content rect, downscale,
 *  encode PNG, persist, and serve to the UI. */
async function capturePageThumb(id: string): Promise<void> {
  const host = getNativeHost() as {
    surface?: {
      width: number;
      height: number;
      captureNextFrame?: (timeoutMs?: number) => Promise<Uint8Array | null>;
    };
  } | null;
  const surf = host?.surface;
  if (!surf?.captureNextFrame) return;
  const frame = await surf.captureNextFrame(2500).catch(() => null);
  if (!frame || store.getState().activePageId !== id) return;

  const s = store.getState();
  const r = s.contentRect;
  const sw = surf.width, sh = surf.height;
  if (frame.length < sw * sh * 4) return;

  // Crop to the content rect (clamped to the surface).
  const cx = Math.max(0, Math.floor(r.x));
  const cy = Math.max(0, Math.floor(r.y));
  const cw = Math.max(1, Math.min(sw - cx, Math.floor(r.w)));
  const ch = Math.max(1, Math.min(sh - cy, Math.floor(r.h)));

  // Downscale to THUMB_W wide preserving aspect (box average).
  const tw = Math.min(THUMB_W, cw);
  const th = Math.max(1, Math.round((ch / cw) * tw));
  const out = new Uint8Array(tw * th * 4);
  const xStep = cw / tw;
  const yStep = ch / th;
  for (let y = 0; y < th; y++) {
    const sy0 = Math.floor(cy + y * yStep);
    const sy1 = Math.max(sy0 + 1, Math.floor(cy + (y + 1) * yStep));
    for (let x = 0; x < tw; x++) {
      const sx0 = Math.floor(cx + x * xStep);
      const sx1 = Math.max(sx0 + 1, Math.floor(cx + (x + 1) * xStep));
      let rr = 0, gg = 0, bb = 0, aa = 0, n = 0;
      for (let sy = sy0; sy < sy1 && sy < sh; sy++) {
        for (let sx = sx0; sx < sx1 && sx < sw; sx++) {
          const si = (sy * sw + sx) * 4;
          rr += frame[si]!; gg += frame[si + 1]!; bb += frame[si + 2]!; aa += frame[si + 3]!;
          n++;
        }
      }
      const oi = (y * tw + x) * 4;
      out[oi] = rr / n; out[oi + 1] = gg / n; out[oi + 2] = bb / n; out[oi + 3] = aa / n;
    }
  }

  try {
    const png = encodePNG(tw, th, out);
    writeFileSync(thumbPath(id), png);
    present.add(id);
    await ui?.loadResource?.(thumbUrl(id), new Uint8Array(png));
    bumpThumb();
  } catch (e) {
    log.warn("thumbs", `capture for ${id} failed: ${e}`);
  }
}
