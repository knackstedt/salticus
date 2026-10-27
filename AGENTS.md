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

## Locally rebuilt platform native lib (RTL text + ctrl-chord textinput)

`node_modules/@downdraft/native-linux-x64/lib/libdowndraft_platform.so` is a
**locally built 0.8.0 + two fixes**, not the shipped one:

1. **RTL**: `ft_shim_render_text` measured text at `f32::MAX` buffer width,
   so cosmic-text anchored RTL runs at x≈line_w (~3e38) and all
   Hebrew/Arabic ink clipped to nothing. The fix re-layouts the buffer at
   the measured advance before drawing — committed upstream as
   `downdraft-engine@a5810f65` (`native-rs/src/text.rs`), ships in >0.8.0.
2. **Ctrl-chord textinput**: `translate_window_event`
   (`native-rs/src/window/events.rs`) forwarded `event.text` for every
   keydown while text input was enabled — on X11 Ctrl+A delivers "a", so
   any Ctrl/Cmd chord (select-all, bold, undo…) also inserted the char and
   replaced the live selection (Ctrl+A wiped the doc). The event now gates
   on modifiers: GUI always suppresses, CTRL suppresses unless ALT is also
   held (Ctrl+Alt = AltGr on Windows). **Not yet committed upstream** — the
   change sits uncommitted in the downdraft-engine working tree.

Until both ship upstream, a `bun install` / package refetch reverts the
local .so — rebuild with `cd
~/Pivot/source/apophis/downdraft-engine/packages/platform-native && bun run
build:native` and copy `native/linux-x64/libdowndraft_platform.so` into
`node_modules/@downdraft/native-linux-x64/lib/`.

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
