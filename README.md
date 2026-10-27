# salticus
A game built with the DownDraft Engine.
## Getting Started

```bash
# Install dependencies
bun install

# Start dev server
npm run dev

# Build for production
npm run build

# Export for distribution
npm run export
```

## Project Structure

```
src/          Game source code
  native-entry.ts  Native runtime entry (draft dev)
assets/       Game assets (models, textures, shaders)
downdraft.config.json   Engine configuration
```

## Engine

Built with [DownDraft Engine](https://github.com/knackstedt/downdraft) — a TypeScript-first game engine on WebGPU — native runtime (Bun + SDL + wgpu).
