// ============================================================================
// frame-governor.ts — render-on-demand scheduling for an idle-friendly app.
//
// GameRenderer's default is a continuous vsync-rate rAF loop. Under software
// rasterization (DOWNDRAFT_GPU=swiftshader → llvmpipe) every frame costs tens
// of CPU-ms spread across worker threads, so a static notes app burns ~6
// cores repainting identical pixels. This governor stops the loop once
// nothing is animating, then services the two remaining periodic needs —
// caret blink and a catch-all safety repaint — with single-frame
// renderOnce() calls at ~2fps.
//
// Wake sources:
//   - store.setState (all app-driven visual mutations funnel through it)
//   - input bus events (registered ahead of every consumer so a
//     stopPropagation can't starve the wake)
//   - window textinput (IME commits may arrive without a keydown)
//   - canvas resize
//   - explicit wakeRenderer() (font load, thumbnail capture, …)
//
// MCP's pauseRendering suspends the governor so deterministic tests keep
// their externally-stopped loop; resumeRendering clears the suspension.
// ============================================================================

import type { GameRenderer } from "@downdraft/engine";
import type { RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import { store } from "./store";

/** A compositor's frame needs, polled while the governor decides whether the
 *  loop keeps running. */
export interface FrameNeeds {
  /** Time-driven animation in flight — hold the loop awake until clear. */
  animating(): boolean;
  /** A blinking caret is on screen — serviced at the idle cadence. */
  wantsBlink(): boolean;
}

/** Lead time after the last wake before the loop may sleep — covers
 *  input-triggered transitions a surface forgot to report via animating(). */
const IDLE_GRACE_MS = 400;
/** Asleep cadence: blink service and (every Nth tick) the safety repaint. */
const IDLE_TICK_MS = 500;
const SAFETY_TICKS = 4;
/** Registered far ahead of every real input handler (lower = earlier). */
const WAKE_PRIORITY = -1e9;

let installed: FrameGovernor | null = null;

/** Wake the render loop from anywhere (thumbnail capture, async loads). */
export function wakeRenderer(): void {
  installed?.wake();
}

export class FrameGovernor {
  private lastWake = performance.now();
  private suspended = false;
  private idleTicks = 0;
  private unsubs: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    mctx: RendererModuleContext,
    private renderer: GameRenderer,
    private sources: () => FrameNeeds[],
  ) {
    this.unsubs.push(store.subscribe(() => this.wake()));

    const bus = mctx.getInputBus();
    const onEvent = () => this.wake();
    this.unsubs.push(bus.onPointerDown(onEvent, WAKE_PRIORITY));
    this.unsubs.push(bus.onPointerMove(onEvent, WAKE_PRIORITY));
    this.unsubs.push(bus.onPointerUp(onEvent, WAKE_PRIORITY));
    this.unsubs.push(bus.onWheel(onEvent, WAKE_PRIORITY));
    this.unsubs.push(bus.onKeyDown(onEvent, WAKE_PRIORITY));
    this.unsubs.push(bus.onKeyUp(onEvent, WAKE_PRIORITY));

    const w = globalThis as {
      addEventListener?: (t: string, f: (e: unknown) => void) => void;
      removeEventListener?: (t: string, f: (e: unknown) => void) => void;
    };
    w.addEventListener?.("textinput", onEvent);
    this.unsubs.push(() => w.removeEventListener?.("textinput", onEvent));

    this.unsubs.push(mctx.onResize(() => this.wake()));

    this.timer = setInterval(() => this.idleTick(), IDLE_TICK_MS);
    installed = this;
  }

  /** Mark activity and ensure the loop is running. No-op while an external
   *  party (MCP pauseRendering) holds the loop stopped. */
  wake(): void {
    if (this.suspended) return;
    this.lastWake = performance.now();
    if (!this.renderer.isRunning()) this.renderer.start();
  }

  /** Call once per rendered frame (the app's afterFrame hook). Stops the
   *  loop once activity has been quiet past the grace period and no surface
   *  reports an in-flight animation. */
  noteFrame(): void {
    if (this.suspended || !this.renderer.isRunning()) return;
    if (this.sources().some((s) => s.animating())) return;
    if (performance.now() - this.lastWake < IDLE_GRACE_MS) return;
    // render()'s tail re-arms one rAF after this stop() — it fires once, sees
    // !running, and lets the chain die. One spare frame per sleep, harmless.
    this.renderer.stop();
  }

  /** Asleep service: blink ticks plus a periodic catch-all repaint for
   *  repaint sources that never produced a wake. */
  private idleTick(): void {
    if (this.suspended || this.renderer.isRunning()) return;
    this.idleTicks++;
    if (this.sources().some((s) => s.wantsBlink()) || this.idleTicks % SAFETY_TICKS === 0) {
      try {
        this.renderer.renderOnce();
      } catch {
        // Device lost / mid-teardown — the next tick retries.
      }
    }
  }

  /** External hold on the loop (MCP pauseRendering): stop and ignore wakes
   *  until resume(). */
  suspend(): void {
    this.suspended = true;
    this.renderer.stop();
  }

  resume(): void {
    this.suspended = false;
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
