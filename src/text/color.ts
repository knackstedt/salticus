// ============================================================================
// color.ts — shared hex parsing with memoization.
//
// Surfaces call hex()/withAlpha() many times per frame with the same handful
// of theme strings; without caching every call allocates a fresh 4-tuple.
// Parsed colors are cached by string and alpha-scaled variants are cached on
// the (shared, immutable) source tuple. Callers must not mutate results.
// ============================================================================

import type { Rgba } from "./gpu-text";

const cache = new Map<string, Rgba>();

export function hex(s: string): Rgba {
  const hit = cache.get(s);
  if (hit) return hit;
  const h = s.slice(1);
  const n = parseInt(h.slice(0, 6), 16);
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  const out: Rgba = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
  cache.set(s, out);
  return out;
}

const alphaCache = new WeakMap<Rgba, Map<number, Rgba>>();

export function withAlpha(c: Rgba, a: number): Rgba {
  let m = alphaCache.get(c);
  if (!m) {
    m = new Map();
    alphaCache.set(c, m);
  }
  const hit = m.get(a);
  if (hit) return hit;
  const out: Rgba = [c[0], c[1], c[2], c[3] * a];
  m.set(a, out);
  return out;
}
