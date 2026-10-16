# DownDraft Engine — API Reference for AI Companions

## Architecture

DownDraft is a TypeScript-first game engine built on winit + wgpu (a single native process, hosted under Bun, Node, or Deno — Bun is the default) + WebGPU, with an MCP server enabling AI agents to design, build, debug, and manage games via natural language.

**Execution contexts:**
1. **Native host (main thread)** — Game module, renderer, render loop, engine orchestrator, MCP server, asset manager
2. **Sim worker** — ECS world, game systems, physics, AI, modules (SharedArrayBuffer channels for frame sync)
3. **DB worker** — Persistence layer with schema versioning

## ECS (Entity Component System)

- **Entity**: `{ index: u32, generation: u32 }` — generational indices prevent stale-handle corruption
- **Component**: Plain data class implementing `Component` interface, registered with `ComponentId`
- **Archetype**: Set of component types, SoA column storage for cache-friendly iteration
- **Query**: Declares read/write access to component types, returns matching archetypes
- **System**: Function `(query, resources, commands) => void`
- **Schedule**: Single-threaded by default, dependency-ordered. Multi-threading via module/SAB.
- **Events**: Double-buffered channels (written this tick, readable next tick)
- **Commands**: Deferred operations (spawn/despawn, add/remove component) applied at stage boundaries

### Hierarchy
- Parent/child tree stored in side table (not archetype columns) — avoids archetype moves on reparenting
- Dirty-flag propagation: parent Transform change marks children dirty (O(depth))
- Lazy world matrix: computed on read when dirty

### Change Detection
- Per-component `lastChanged` tick counter — O(1) check for consumers
- Cross-thread: `Atomics` on SAB headers for frame sync

## Core API

```typescript
import { World, Camera, MeshBuilder, Component, system, createLogger } from "@downdraft/engine";

// Define components
const Health = Component.register<{ current: number; max: number }>("Health", { current: 100, max: 100 });

// Define a system
const damageSystem = system(
  (w: World, dt: number) => {
    const view = w.view([Health]);
    for (const ent of view) {
      const health = w.getComponent(ent, Health);
      if (health && health.data.current <= 0) {
        w.despawn(ent);
      }
    }
  }
);

// Setup
const world = new World();
const camera = new Camera();
camera.setAspect(16, 9);
world.setResource("camera", camera);

// Spawn entities
const entity = world.spawn();
world.addComponent(entity, Health.create({ current: 50, max: 100 }));

// Procedural meshes
const cube = MeshBuilder.cube(1);
const sphere = MeshBuilder.sphere(0.5, 16, 16);
```

## Module System

Modules are loadable packages that register systems, components, resources, and assets.

```typescript
import { Module } from "@downdraft/engine";

const myModule: Module = {
  name: "my-module",
  register(ctx: ModuleContext) {
    // Register components, systems, resources
  },
};

world.registerModule(myModule);
```

### Engine Libraries (`@downdraft/engine/libraries/*`)
- `@downdraft/engine/libraries/water` — Gerstner waves, refraction, reflection
- `@downdraft/engine/libraries/physics-rapier` — Rapier physics backend
- `@downdraft/engine/libraries/physics-native` — Pure-TS physics backend
- `@downdraft/engine/libraries/marching-cubes` — Volumetric deformable terrain
- `@downdraft/engine/libraries/surface-nets` — Surface nets mesh extraction
- `@downdraft/engine/libraries/models` — GLTF/GLB/PLY/3DS model loading
- `@downdraft/engine/libraries/audio-kira` — Kira audio backend
- `@downdraft/engine/libraries/entities` — Generic model renderer
- `@downdraft/engine/libraries/lighting` — Lighting system
- `@downdraft/engine/libraries/weather` — Weather simulation
- `@downdraft/engine/libraries/weatherfx` — Cloud particle effects
- `@downdraft/engine/libraries/navmesh` — Navigation meshes
- `@downdraft/engine/libraries/persistence` — Save system (directory-handle + file stores)
- `@downdraft/engine/libraries/networking` — Multiplayer networking
- `@downdraft/engine/libraries/gaussian-splats` — Gaussian splat rendering
- `@downdraft/engine/libraries/sand` — Falling-sand simulation
- `@downdraft/engine/libraries/stickman` — Stickman skeleton rendering

### Engine Modules (`@downdraft/engine/modules/*`)
- `@downdraft/engine/modules/devtools` — DevTools panel, scene inspector, GPU debugging
- `@downdraft/engine/modules/camera-controls` — Camera input handling
- `@downdraft/engine/modules/terrain` — Terrain composition (marching-cubes + LOD)
- `@downdraft/engine/modules/movement-3d` — 3D player movement
- `@downdraft/engine/modules/movement-2d` — 2D grid-based movement
- `@downdraft/engine/modules/sailing` — Sailing mechanics (wind, buoyancy, steering)
- `@downdraft/engine/modules/mcp` — MCP automation server
- `@downdraft/engine/modules/xr` — WebXR support

### Game Modules (to-the-ocean example: `@to-the-ocean/module-*`)
- `@to-the-ocean/module-crafting` — Crafting recipes and system
- `@to-the-ocean/module-inventory` — Inventory system
- `@to-the-ocean/module-wildlife` — Wildlife AI (fish, sharks, eels, etc.)
- `@to-the-ocean/module-buoyancy` — Water buoyancy physics
- `@to-the-ocean/module-collision` — Entity collision detection

### Game Libraries (to-the-ocean example: `@to-the-ocean/library-*`)
- `@to-the-ocean/library-items` — Item definitions and management
- `@to-the-ocean/library-fishing` — Fishing mechanics
- `@to-the-ocean/library-economy` — Market/trading system
- `@to-the-ocean/library-survival` — Survival stats (hunger, thirst, oxygen)
- `@to-the-ocean/library-boats` — Boat building and piloting

## Builder Modes

| Mode | Use case |
|---|---|
| **dev** | Full DevTools, hot-reload, telemetry. Fastest iteration. |
| **debug** | Local verification on the production native runtime. |
| **prod** | Optimized production build. No devtools/debug overhead. |

## CLI Commands

```
draft new [path] [options]      Scaffold a new game project
draft dev [options]             Start dev server with HMR
draft debug [options]           Run engine in debug mode
draft release [options]         Unified build + package + sign pipeline
                                (--stage=build|package|release, --target=win|linux|mac|all)
draft assets <cmd>              Manage remote asset packs
```

## MCP Tools (for AI agents)

The MCP server exposes tools for scene management, entity operations, component manipulation, material/shader editing, mesh import, animation, lighting, camera, physics, audio, scripting, asset management, debugging, checkpoints, and build/export.

## Conventions

- **Logging**: No manual `[module]` prefixes — automatic source attribution
- **Loops**: Prefer indexed `for` loops over `for..of`
- **Package manager**: Bun (workspace protocol for internal deps)
