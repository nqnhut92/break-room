# 0010 — Shared population tiers for VKL health

- Status: Accepted
- Recorded: 2026-11-05
- Supersedes / superseded by: none

## Context

VKL previously kept fixed maximum HP and divided ordinary hit damage by the number of nearby targets. The desired behavior is visible maximum-HP growth based on real room-wide online players, preserving damage already dealt. Concealed moles share public player lists, so public online counts cannot be used as the authoritative scaling input. Multiple server instances may hit the boss while a runner adjusts its HP.

## Decision

Extend the shared boss record with maximum HP, private per-threshold presence timers, the last observation time and a monotonic health revision. The leased runner calls an atomic store operation each second. It counts fresh presence IDs excluding the store's mole registry, including downed humans and humans outside the boss zone. Pending timers persist across runner handover; an observation gap above three seconds resets them rather than assuming continuous population during an outage.

Groups of four humans select tiers. A newly reached tier must remain reached for 15 seconds. Add the maximum-HP difference to current HP, preserving damage and the existing damage ledger. The maximum only grows during a life; respawn recalculates it from current real presence. A reconnect cannot repeatedly add the same tier. Remove crowd-based ordinary damage reduction.

Compute percentage ultimates and rack support against stored maximum HP in the same atomic mutation as their damage. Preserve consumed rack and snake-wave markers across population growth. Include current/max HP and health revision in updates and welcome; clients ignore older health revisions. Never publish human counts, pending timers or mole membership through this feature.

This extends the shared atomic-store and leased-runner design in [0001](0001-shared-state.md) and [0002](0002-leased-npc-runners.md). It retains the rack/event lifecycle in [0009](0009-office-patrol-and-rack-support.md).

## Alternatives

- Retaining fixed HP and ordinary-hit resistance hides the requested visible HP growth and makes ordinary/ultimate scaling inconsistent.
- Preserving HP percentage would erase part of previously dealt damage when the maximum grows; additive growth preserves absolute damage instead.
- Lowering maximum HP on departures allows disconnects to weaken or finish a boss and creates churn during refreshes.
- Counting public online slots includes disguised bots. Publishing a human-only roster would reveal them. Bucketed delayed HP changes reduce direct identity clues but cannot guarantee concealment against inference from public HP and online lists.
- Local timers/counts would disagree across instances and reset after leader handover.

## Consequences

Boss health does not depend on which instance a player joined. Atomic growth/hits cannot overwrite each other; late health events cannot undo newer health on the client. Remaining players inherit a higher tier if others leave until the boss dies. Independent guest identities/accounts can still inflate the real-player count; this design counts sessions/actors, not verified distinct people.

The runner adds one atomic presence/health operation per active room per second. Existing room TTL and lease apply; inactive rooms do no work. Max HP already earned remains durable, while unobserved pending growth is restarted after inactivity. `BOSS_MAX_HP`/the test override supplies the base HP; each additional tier adds half that base.

## References

- [Population rules](../BOSS.md#population-health), [Vietnamese](../BOSS.vi.md#máu-theo-số-người)
- [Population reducer](../../lib/boss-population.js), [memory store](../../lib/store-memory.js), [Redis store](../../lib/store-redis.js)
- [Shared-store and two-instance checks](../../test/shared.js), [browser health ordering/map checks](../../test/minimap-ui.cjs)
