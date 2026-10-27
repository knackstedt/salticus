# salticus — agent notes

## Running

- `bun run dev` starts the app via `draft dev`. Since engine 0.7.x the
  hardware-GPU path works on this machine (RTX 3090 / Vulkan); the old
  wgpu/mesa init panic (Bun abort, exit 129) is fixed. `swiftshader`
  remains selectable via `DOWNDRAFT_GPU=swiftshader draft dev` and is what
  the MCP deterministic harness uses.
- Rendering is damage-driven (engine `damageOnly` since 0.8.0): the rAF
  chain parks when no compositor reports `takeDirty()`, keepalive ticks
  run frame hooks at `damageIdleFps` (4Hz here). New surfaces must return
  false from `takeDirty()` when unchanged — an always-true compositor
  keeps the chain hot. Mutations mark frames via engine input/resize
  marks, `ctx.requestFrame()` in tick/update (blink flips, animations),
  or the FrameGovernor bridge (store subscribe, textinput, `wakeRenderer()`).
  Do NOT hand-roll partial swapchain repaints — `getCurrentTexture()`
  hands back rotating backbuffers whose retained contents are undefined;
  a scissored load-pass presents stale/black frames (tried, reverted).
- `DOWNDRAFT_DETERMINISTIC=1` additionally stabilizes rendering for
  screenshot-based testing.
- `bun draft dev --no-hmr` runs the entry directly without the dev shell.
- HMR restarts can crash the Bun host; a clean restart is the reliable
  recovery.

## Verification

- Typecheck: `bunx tsc --noEmit`
- Smoke suite: `SALTICUS_PID=<pid> bun run scripts/smoke.ts` — drives a running
  instance over MCP (launch it first).
- MCP discovery: `~/.downdraft/port/<pid>` + `<pid>.token`. Other
  DownDraft projects leave stale/alien entries — probe `app_state` to
  confirm an instance is salticus before driving it.

## Conventions

- TypeScript everywhere; avoid `for..of` and `while` loops (use `.forEach`
  or indexed `for`).
- No Devin co-author trailer in commits.

## Upstream fixes absorbed in 0.9.0

Two fixes that previously required a locally rebuilt
`libdowndraft_platform.so` / patched package JS shipped upstream in 0.9.0 —
a plain `bun install` is now correct, no repatching needed:

1. **RTL text**: `ft_shim_render_text` re-layouts at the measured advance
   (`downdraft-engine@a5810f65`, `native-rs/src/text.rs`) — fixed RTL runs
   anchoring at x≈3e38 and clipping to nothing.
2. **Ctrl-chord textinput**: `translate_window_event`
   (`native-rs/src/window/events.rs`) gates `event.text` on modifiers
   (`chorded` check) — Ctrl/Cmd chords no longer insert chars over the
   live selection.
3. **iconPath**: `runNativeAppModule` (the 0.9.0 rename of
   `runNativeGameModule`) accepts `iconPath` natively — `_NET_WM_ICON` /
   taskbar icon works from stock packages.

If a future upgrade regresses these, the rebuild recipe is
`cd ~/Pivot/source/apophis/downdraft-engine/packages/platform-native &&
bun run build:native` then copy `native/linux-x64/libdowndraft_platform.so`
into `node_modules/@downdraft/native-linux-x64/lib/`.

## Render-on-demand (frame governor)

`src/app/frame-governor.ts` is the app-side wake bridge for `damageOnly` —
it does not own the loop. It translates app signals the engine can't see
(`store.setState`, `textinput`, `wakeRenderer()` for font loads and
thumbnail captures) into `ctx.requestFrame()` marks, plus a ~2s safety mark
and MCP `suspend`/`resume` plumbing. Each `ScreenUiCompositor` owns its own
dirty reporting: `takeDirty()` (frame-pending mutations, `animating()`
lerps, a settle frame) and blink flips marked via `ctx.requestFrame()` in
`tick`/`update` while `wantsBlink()`. Keep `animating()` honest or the loop
never sleeps — exponential lerps must snap to their target or they report
"animating" forever. `tick`/`update` clocks use wall-clock deltas, not the
engine's capped `dt`.

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
