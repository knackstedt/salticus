import { GameRenderer } from "@downdraft/engine";
import type { GameModule } from "@downdraft/engine/app/main";
import { createHtmlUi } from "@downdraft/engine/modules/html-ui";
import { createGameMcp } from "@downdraft/engine/app/main";
import { createLogger } from "@downdraft/engine/util/logger";
import { mountShell } from "./ui/shell";
import { store } from "./app/store";
import { gameMcpTools } from "./mcp/tools";

const log = createLogger();

// ============================================================================
// Graphic Notes — renderer-only GameModule
//
// A notes app has no simulation worker: everything (document state, layout,
// animation) lives on the renderer thread. The renderer runs in 2D mode with
// zero viewports — the frame is painted by registered ScreenUiCompositors:
//   - our custom GPU surfaces (document editor, whiteboard) at order < 0
//   - html-ui panels (Blitz docs) at order 0
// ============================================================================

const BG = { r: 0x19 / 255, g: 0x1b / 255, b: 0x1e / 255, a: 1 };

export const gameModule: GameModule = {
  renderer: (surface) =>
    new GameRenderer(surface, {
      mode: "2d",
      clearColor: BG,
      enableTelemetry: true,
    }),

  ui: (ctx) => {
    const renderer = ctx.renderer as GameRenderer;
    renderer.setViewportCount(0);

    const mod = createHtmlUi({
      name: "graphic-notes-ui",
      nav: false,
      build(ui) {
        mountShell(ui, ctx);
      },
    });
    renderer.useRendererModule(mod);

    return {
      start() {
        log.info("game", "ui started");
      },
      dispose() {
        store.setState({ running: false });
      },
    };
  },

  mcp: (ctx) => {
    const renderer = ctx.renderer as GameRenderer;
    createGameMcp({
      appId: "downdraft-graphic-notes",
      surface: ctx.surface,
      isRunning: () => renderer.isRunning?.() ?? true,
      renderOnce: () => renderer.renderOnce?.(),
      pauseRendering: () => renderer.stop(),
      resumeRendering: () => renderer.start(),
      getWorldState: () => store.getState().worldState?.() ?? null,
      getUiState: () => store.getState().uiState?.() ?? null,
      setTestState: (params) => store.getState().setTestState?.(params),
      conditionVars: {
        app: () => store.getState(),
      },
      tools: gameMcpTools(ctx),
    });
  },

  onReady: (ctx) => {
    log.info("game", "ready");
    store.getState().onReady?.(ctx);
  },

  onDispose: () => {
    store.getState().onDispose?.();
  },
};
