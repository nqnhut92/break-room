# 0004 — Shared static layout, collision geometry and stable object IDs

- Status: Accepted
- Recorded: 2026-11-04 (existing design and approved layout revision documented retrospectively)
- Supersedes / superseded by: none

## Context

The server must reject movement through furniture and walls, and the browser needs matching geometry for local movement. Redis stores object state by ID. The previous layout left unintended paths around incomplete walls and between rooms. A smashed object also remains visible as wreckage.

## Decision

Define the world, furniture, room bounds and doors in `lib/world.js`. Generate continuous shared walls for closed rooms from `FLOOR_ROOMS` (explicitly open workspace areas omit partitions), merging collinear spans so adjacent rooms share physical boundaries. Connect rooms through intentional doors and corridors. Share the collision model between client and server, using stepped movement resolution to avoid crossing thin obstacles.

Keep collision geometry static for a room's lifetime: wreckage still blocks movement. Preserve existing object IDs and types when relocating furniture so stored health and broken-state overlays continue to refer to the same objects.

## Alternatives

- Separate visual and server layouts can drift, leaving invisible obstacles or apparent walls that can be crossed.
- Independent room boxes with offsets can create accidental sliver paths.
- Removing colliders on destruction could open paths, but would require authoritative collision updates and consistent client synchronisation.
- Renumbering objects would require a deliberate state migration or reset.

## Consequences

Layout and collision rules remain deterministic, and smashing does not alter navigation. Paths can stay blocked by wreckage until objects respawn. A map edit must verify every breakable is reachable, spawn/exit are clear, doors are walkable and room walls are continuous. Revisit this decision if gameplay requires destructible walls or changing navigation; account for persisted object state in any migration.

## References

- [World definition](../../lib/world.js), [layout regression checks](../../test/world.js)
- [Map overview](../../artifacts/map-overview.png)
- [Gameplay](../GAMEPLAY.md), [development](../DEVELOPMENT.md)
