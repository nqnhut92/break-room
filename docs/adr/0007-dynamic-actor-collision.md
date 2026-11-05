# 0007 — Shared dynamic boss bodies without player blocking

- Status: Accepted
- Date: 2026-11-05

## Context

Static rectangle collision already prevents walking through walls/furniture, but players could walk through VKL and TML/DMM. Making all characters solid would allow doorway griefing and could reveal disguised bots if they followed a different rule. Network snapshots and client prediction must agree without new per-movement storage queries.

## Decision

Living bosses/mini-bosses are circular movement obstacles; defeated bodies are omitted. Players and bots remain mutually nonblocking. NPC movement avoids living characters without making contact an aggression trigger. Existing radii, attack distances, damage, map geometry and forced duel effects are retained.

Use `public/actor-collision.js` in both browser and Node: it subdivides movement to prevent tunneling, resolves circle overlap with static geometry, and allows sliding and escape from initial overlap. The browser predicts using the latest authoritative NPC targets; the server rechecks movement against its runner/snapshot state, sends corrections, and separates residual overlap in its position loop. Forced pull/blow animations finish before ordinary overlap separation resumes. No persistent storage traffic or public bot identity fields are added.

## Alternatives

- Solid players and bots: rejected for doorway blocking, crowd trapping and latency corrections.
- Solid bots but nonblocking humans: rejected because it exposes hidden NPCs.
- Client-only collision: rejected because forged moves bypass it.
- Endpoint-only checks: rejected because a single movement message can cross an entire body.
- Duplicate client/server math: rejected to prevent prediction drift.

## Consequences and evidence

Bosses can physically obstruct narrow routes, and players can obstruct NPC walking; attacks and navigation keep their existing rules. Moving snapshots can still produce small corrections under latency. Static layout remains governed by ADR 0004; this extends it with dynamic bodies.

`test/actor-collision.js` checks tunneling, sliding, wall constraints, initial overlap, neutral wandering, humanoid pass-through and living/defeated boss behavior over real WebSockets. Browser entry and input tests continue separately.
