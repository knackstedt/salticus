import { GameRenderer } from "@downdraft/engine";
import type { GameModule } from "@downdraft/engine/app/main";
import type { RendererModule } from "@downdraft/engine/module/renderer-module";
import { createHtmlUi } from "@downdraft/engine/modules/html-ui";
import { createGameMcp } from "@downdraft/engine/app/main";
import { createLogger } from "@downdraft/engine/util/logger";
import { mountShell } from "./ui/shell";
import { store } from "./app/store";
import { gameMcpTools } from "./mcp/tools";
import { EditorSurface, darkTheme, lightTheme } from "./editor/surface";
import { KanbanSurface } from "./board/surface";
import { WhiteboardSurface } from "./wb/surface";
import { PaletteSurface } from "./ui/palette";
import { RunCache } from "./text/run-cache";
import { TextAtlas } from "./text/atlas";
import { loadFaces } from "./text/fonts";
import { initWorkspace, installAutosave, flushNow } from "./app/workspace";
import { installPageController } from "./app/page-controller";

const log = createLogger();

/** Live view surfaces — installed by the renderer module, read by MCP tools. */
export let editorSurface: EditorSurface | null = null;
export let kanbanSurface: KanbanSurface | null = null;
export let wbSurface: WhiteboardSurface | null = null;
let pageCtl: (() => void) | null = null;

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

    // Workspace metadata must be loaded before the shell builds its lists.
    try {
      initWorkspace();
    } catch (e) {
      log.warn("game", `workspace init failed: ${e}`);
    }
    const unsubAutosave = installAutosave();

    const mod = createHtmlUi({
      name: "graphic-notes-ui",
      nav: false,
      build(ui) {
        mountShell(ui, ctx);
      },
    });
    renderer.useRendererModule(mod);

    // Custom GPU surfaces — drawn beneath the chrome panels. All views share
    // one glyph atlas/run cache so shaped text is reused across surfaces.
    const surfacesModule: RendererModule = {
      name: "gn-surfaces",
      version: "0.1.0",
      register(mctx) {
        const atlas = new TextAtlas(mctx.getDevice(), 2048);
        const cache = new RunCache(atlas);
        const surf = new EditorSurface(mctx, cache);
        const board = new KanbanSurface(mctx, cache);
        const wb = new WhiteboardSurface(mctx, cache);
        const palette = new PaletteSurface(mctx, cache);
        editorSurface = surf;
        kanbanSurface = board;
        wbSurface = wb;
        surf.setRect(store.getState().contentRect);
        board.setRect(store.getState().contentRect);
        wb.setRect(store.getState().contentRect);
        palette.setRect(store.getState().contentRect);
        mctx.registerUiCompositor?.(surf);
        mctx.registerUiCompositor?.(board);
        mctx.registerUiCompositor?.(wb);
        mctx.registerUiCompositor?.(palette);
        mctx.onFrame("afterFrame", (dt) => { surf.tick(dt); board.update(dt); wb.update(dt); palette.update(dt); });
        surf.setAnimationsEnabled(store.getState().editorAnimations);
        let lastTheme = store.getState().theme;
        const unsub = store.subscribe((s) => {
          surf.setRect(s.contentRect);
          board.setRect(s.contentRect);
          wb.setRect(s.contentRect);
          palette.setRect(s.contentRect);
          surf.setAnimationsEnabled(s.editorAnimations);
          if (s.theme !== lastTheme) {
            lastTheme = s.theme;
            surf.setTheme(s.theme === "dark" ? darkTheme() : lightTheme());
          }
        });
        void surf.init().then(async () => {
          const defs = await loadFaces();
          for (const def of defs) cache.registerFace(def);
          pageCtl = installPageController({ editor: surf, kanban: board, whiteboard: wb });
          surf.enableTextInput();
        }).catch((e) => log.warn("game", `editor init failed: ${e}`));
        mctx.onDispose(() => {
          pageCtl?.();
          pageCtl = null;
          unsub();
          unsubAutosave();
          flushNow();
          surf.dispose();
          board.dispose();
          wb.dispose();
          palette.dispose();
          cache.dispose();
          atlas.destroy();
          if (editorSurface === surf) editorSurface = null;
          if (kanbanSurface === board) kanbanSurface = null;
          if (wbSurface === wb) wbSurface = null;
        });
      },
    };
    renderer.useRendererModule(surfacesModule);

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
