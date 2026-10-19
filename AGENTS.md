# graphic-notes — agent notes

## Running

- `bun run dev` starts the app via `draft dev`. The dev script pins
  `DOWNDRAFT_GPU=swiftshader` — do **not** remove it. The hardware-GPU path
  (`DOWNDRAFT_GPU` unset or `hardware`) panics inside wgpu/mesa during
  adapter init on this machine (Bun abort, exit 129). `swiftshader` is the
  same default the MCP harness uses.
- `DOWNDRAFT_DETERMINISTIC=1` additionally stabilizes rendering for
  screenshot-based testing.
- `bun draft dev --no-hmr` runs the entry directly without the dev shell.
- HMR restarts can crash the Bun host; a clean restart is the reliable
  recovery.

## Verification

- Typecheck: `bunx tsc --noEmit`
- Smoke suite: `GN_PID=<pid> bun run scripts/smoke.ts` — drives a running
  instance over MCP (launch it first).
- MCP discovery: `~/.downdraft/port/<pid>` + `<pid>.token`. Other
  DownDraft projects leave stale/alien entries — probe `app_state` to
  confirm an instance is graphic-notes before driving it.

## Conventions

- TypeScript everywhere; avoid `for..of` and `while` loops (use `.forEach`
  or indexed `for`).
- No Devin co-author trailer in commits.

## Locally patched platform native lib (RTL text)

`node_modules/@downdraft/native-linux-x64/lib/libdowndraft_platform.so` is a
**locally rebuilt copy**, not the shipped binary. `ft_shim_render_text`
(cosmic-text) set the buffer width to `f32::MAX` for wrap avoidance, so RTL
runs laid out starting at x≈3e38 and all RTL ink clipped to nothing — pure
Hebrew/Arabic strings rasterized blank. The vendored patch re-layouts the
buffer at the measured advance before drawing (see
`packages/platform-native/native-rs/src/text.rs` in
`~/source/downdraft-engine`, function `ft_shim_render_text`). A patched
source tree + build artifacts live at `/tmp/dd-native` + `/tmp/dd-target`;
the original binary is backed up at `/tmp/libdowndraft_platform.so.orig`.
The same fix should be applied upstream — a `bun install` / package update
will revert the local .so and break RTL rendering again.

## Text pipeline map

- `src/text/fonts.ts` — bundled faces + `FALLBACK_FACES` ordered chain
  (system Noto faces: script coverage → symbols → CJK → droid-fallback →
  emoji last).
- `src/text/run-cache.ts` — `fallbackPieces()` splits text by which chain
  face covers it (harfbuzz `.notdef` detection, RTL-aware `missingRanges`);
  `getChunk()` prefers CBDT color bitmaps when present.
- `src/text/cbdt.ts` — NotoColorEmoji CBDT/CBLC parser (format-17 records:
  metrics 5B + dataSize 4B + PNG).
- `src/text/image-decode.ts` — FFI wrapper for `image_shim_decode`.
- `src/text/shaper.ts` — clusterOffsets handle descending (RTL) clusters.
- `src/editor/layout.ts` — token widths/hit-test/caret use absolute
  cluster-offset deltas (RTL-safe).
