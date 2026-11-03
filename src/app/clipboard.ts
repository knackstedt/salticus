// System clipboard access. The native platform clipboard (arboard) only
// reaches the X11 selection, and on Wayland sessions without X11↔Wayland
// bridging, copies made in Wayland-native apps are invisible to it (and
// ours never reach them). wl-clipboard covers the Wayland data device, so
// writes are mirrored to both sides and reads pick whichever side changed
// since our last write.

import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger();

type NativeWindow = {
  getClipboardText?: () => string;
  setClipboardText?: (t: string) => void;
};

function nw(): NativeWindow | undefined {
  return (globalThis as { __nativeWindow?: NativeWindow }).__nativeWindow;
}

let wlOk: boolean | null = null;
function wlBridge(): boolean {
  if (wlOk !== null) return wlOk;
  try {
    // No env gate: wl-paste/wl-copy exit non-zero when there is no Wayland
    // session anyway, and the app context may not expose process.env.
    wlOk = !!Bun.which("wl-copy") && !!Bun.which("wl-paste");
  } catch {
    wlOk = false;
  }
  return wlOk;
}

function wlPaste(type: string): string {
  try {
    const r = Bun.spawnSync(["wl-paste", "-n", "-t", type], { stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString() : "";
  } catch {
    return "";
  }
}

let x11Ok: boolean | null = null;
function x11Paste(type: string): string {
  if (x11Ok === null) {
    try { x11Ok = !!Bun.which("xclip"); } catch { x11Ok = false; }
  }
  if (!x11Ok) return "";
  try {
    const r = Bun.spawnSync(["xclip", "-selection", "clipboard", "-o", "-t", type], { stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString() : "";
  } catch {
    return "";
  }
}

// Last text this process wrote. Lets clipboardGet() tell "changed
// externally since our write" apart from "still holds our copy".
let lastSet: string | null = null;

export function clipboardSet(text: string): void {
  lastSet = text;
  try { nw()?.setClipboardText?.(text); } catch (e) { log.warn("clipboard", `set failed: ${e}`); }
  if (!wlBridge()) return;
  try {
    Bun.spawnSync(["wl-copy"], { stdin: new TextEncoder().encode(text), stderr: "ignore" });
  } catch { /* wl-clipboard is optional */ }
}

export interface ClipboardRead {
  /** text/plain content. */
  text: string;
  /** text/html content, when the clipboard offers it ("" otherwise). */
  html: string;
}

/** Read the clipboard: freshest text plus any text/html sibling from the
 *  same side. Apps that copy rich text offer html alongside the stripped
 *  plain text — callers that can use it should prefer `html`. */
export function clipboardGetRich(): ClipboardRead {
  let x11 = "";
  try { x11 = nw()?.getClipboardText?.() ?? ""; } catch { /* treat as empty */ }
  if (!wlBridge()) return { text: x11, html: x11Paste("text/html") };
  const wl = wlPaste("text");
  const wlh = wlPaste("text/html");
  if (wl && wl !== x11 && (!x11 || x11 === lastSet || wl !== lastSet)) {
    return { text: wl, html: wlh };
  }
  // The X11 side looks fresher — but an html-only Wayland offer (no
  // text/plain sibling) still wins over an empty or self-owned X11 side.
  if (!x11 || x11 === lastSet) {
    if (wlh) return { text: wl, html: wlh };
  }
  return { text: x11, html: x11Paste("text/html") };
}

export function clipboardGet(): string {
  return clipboardGetRich().text;
}
