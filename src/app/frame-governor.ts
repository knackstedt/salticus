// ============================================================================
// frame-governor.ts — wake bridge over the engine's damage-driven renderer
// (GameRendererConfig.damageOnly).
//
// The engine parks its rAF chain when nothing reports damage; parked ticks
// run frame hooks at damageIdleFps so producers can keep marking. Damage
// marks the engine already generates itself: surface pointer/wheel events,
// window key events, resize, worker passes, renderOnce. This module bridges
// the marks it can't see:
//   - store.setState (all app-driven visual mutations funnel through it)
//   - window textinput (IME commits arrive without a keydown)
//   - explicit wakeRenderer() (font load, thumbnail capture, …)
// plus a slow safety re-mark so a mutation that slipped every wake path
// can't stall the UI.
//
// MCP's pauseRendering suspends the governor so deterministic tests keep
// their externally-stopped loop; resumeRendering clears the suspension.
//
// NOTE: an earlier version repainted caret blinks via a scissored
// loadOp:"load" pass on the acquired swapchain image. That assumed the
// acquired backbuffer retained the last presented frame's contents — true
// on old llvmpipe timing, false in general (multi-buffer swapchains hand
// back stale/never-written images → black flashes). Damage service was
// removed; blink flips mark normal frames via ctx.requestFrame().
// ============================================================================

import type { AppRenderer } from "@downdraft/engine";
import type { RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import { store } from "./store";

/** Safety re-mark cadence while idle — catches a mutation that slipped past
 *  every wake path (cheap: one marked frame every ~2s). */
const IDLE_TICK_MS = 500;
const SAFETY_TICKS = 4;

let installed: FrameGovernor | null = null;

/** Wake the render loop from anywhere (thumbnail capture, async loads). */
export function wakeRenderer(): void {
  installed?.wake();
}

export class FrameGovernor {
  private suspended = false;
  private idleTicks = 0;
  private unsubs: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private mctx: RendererModuleContext,
    private renderer: AppRenderer,
  ) {
    this.unsubs.push(store.subscribe(() => this.wake()));

    const onEvent = () => this.wake();
    const w = globalThis as {
      addEventListener?: (t: string, f: (e: unknown) => void) => void;
      removeEventListener?: (t: string, f: (e: unknown) => void) => void;
    };
    w.addEventListener?.("textinput", onEvent);
    this.unsubs.push(() => w.removeEventListener?.("textinput", onEvent));

    this.timer = setInterval(() => {
      if (this.suspended) return;
      if (++this.idleTicks % SAFETY_TICKS === 0) this.wake();
    }, IDLE_TICK_MS);
    installed = this;
  }

  /** Mark a damaged frame — re-arms the parked chain and paints. No-op while
   *  suspended (MCP pauseRendering holds the loop stopped). */
  wake(): void {
    if (this.suspended) return;
    this.mctx.requestFrame();
  }

  /** External hold on the loop (MCP pauseRendering): stop and ignore wakes
   *  until resume(). */
  suspend(): void {
    this.suspended = true;
    this.renderer.stop();
  }

  resume(): void {
    this.suspended = false;
    this.renderer.start();
    this.wake();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (installed === this) installed = null;
  }
}
