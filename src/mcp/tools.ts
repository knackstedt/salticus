// ============================================================================
// mcp/tools.ts — game-specific MCP automation tools layered on the standard
// set (capture_screenshot, dispatch_key, dispatch_click, wait_for_condition…).
// Registered via createGameMcp({ tools }).
// ============================================================================

import type { GameContext } from "@downdraft/engine/app/main";
import { jsonResult, type McpToolRegistration } from "@downdraft/engine/app/main/mcp-harness";
import { store } from "../app/store";
import { createPage, deletePage, openPage, renamePage } from "../app/actions";
import { editorSurface } from "../game-module";

export function gameMcpTools(_ctx: GameContext): McpToolRegistration[] {
  return [
    {
      def: {
        name: "type_text",
        description: "Insert text at the editor caret (bypasses OS text input — for automation).",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
      handler: (p) => {
        const surf = editorSurface;
        if (!surf) return jsonResult({ ok: false, error: "editor not ready" });
        surf.insertTextPublic(String(p.text ?? ""));
        return jsonResult({ ok: true, caret: surf.caret });
      },
    },
    {
      def: {
        name: "editor_state",
        description: "Dump editor surface state: caret, focus, doc stats.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: () => {
        const surf = editorSurface;
        if (!surf) return jsonResult({ ok: false, error: "editor not ready" });
        return jsonResult({
          ok: true,
          ready: surf.ready,
          caret: surf.caret,
          blocks: surf.document.blocks.length,
          cache: surf.runCache.stats,
        });
      },
    },
    {
      def: {
        name: "app_state",
        description: "Dump app-level state: pages, tabs, active page, theme, content rect.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: () => {
        const s = store.getState();
        return jsonResult({
          pages: s.pages,
          rootOrder: s.rootOrder,
          openTabs: s.openTabs,
          activePageId: s.activePageId,
          contentRect: s.contentRect,
          theme: s.theme,
          saveIndicator: s.saveIndicator,
        });
      },
    },
    {
      def: {
        name: "create_page",
        description: "Create a page. Params: title?, type? (doc|board|whiteboard), parentId?, open?",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            type: { type: "string", enum: ["doc", "board", "whiteboard"] },
            parentId: { type: "string" },
            open: { type: "boolean" },
          },
        },
      },
      handler: (p) => {
        const page = createPage({
          title: p.title as string | undefined,
          type: p.type as "doc" | "board" | "whiteboard" | undefined,
          parentId: (p.parentId as string | undefined) ?? null,
          open: p.open as boolean | undefined,
        });
        return jsonResult(page);
      },
    },
    {
      def: {
        name: "open_page",
        description: "Open a page by id (activates it + adds a tab).",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
      handler: (p) => {
        openPage(p.id as string);
        return jsonResult({ ok: true, activePageId: store.getState().activePageId });
      },
    },
    {
      def: {
        name: "rename_page",
        description: "Rename a page. Params: id, title",
        inputSchema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } }, required: ["id", "title"] },
      },
      handler: (p) => {
        renamePage(p.id as string, p.title as string);
        return jsonResult({ ok: true });
      },
    },
    {
      def: {
        name: "delete_page",
        description: "Soft-delete a page (moves to trash). Params: id",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
      handler: (p) => {
        deletePage(p.id as string);
        return jsonResult({ ok: true });
      },
    },
    {
      def: {
        name: "set_theme",
        description: "Switch theme. Params: theme (dark|light)",
        inputSchema: { type: "object", properties: { theme: { type: "string", enum: ["dark", "light"] } }, required: ["theme"] },
      },
      handler: (p) => {
        store.setState({ theme: p.theme === "light" ? "light" : "dark" });
        return jsonResult({ ok: true, theme: store.getState().theme });
      },
    },
  ];
}
