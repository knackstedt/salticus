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
