import { runNativeGameModule } from "@downdraft/platform-native";
import { gameModule } from "./game-module";

// Native entry — `draft dev`/`draft release` runtime (winit + wgpu under Bun, Node, or Deno).
// Saves, MCP, display info, and screenshots work through the in-process
// HostAPI bridge.

await runNativeGameModule(gameModule, {
  title: "graphic-notes — Native",
  appId: "downdraft-graphic-notes",
}).catch((e) => {
  console.error("[native-entry] Fatal:", e);
  process.exit(1);
});
