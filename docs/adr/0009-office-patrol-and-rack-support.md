# 0009 — Reuse the NPC lease for office patrol and commit rack support atomically

- Status: Accepted
- Recorded: 2026-11-05
- Supersedes / superseded by: none

## Context

Players should discover office hazards using existing movement/attack controls. Server racks should trade player health for a limited contribution to VKL combat. A temporary global patrol must survive reconnects and runner loss across Vercel instances, while disguised moles remain indistinguishable from players when hit by bosses. Redis connections are constrained.

## Decision

Keep the office schedule, version and roaming pose in the existing boss hash. The current boss-lease holder commits versioned updates, broadcasts transitions and saves active/returning poses once per second through the existing housekeeping loop. Join restores the shared deadline. Reuse the cached navigation graph with clearance for VKL's larger body, ordinary windups and existing damage messages. No additional connection, scheduler service or action button is introduced.

Commit rack destruction, normal score and once-per-rack-per-boss-life support in the same object-hit operation. Support markers survive IT replacement and clear on boss respawn. Cap support at 2% per rack and keep at least 1 boss HP; support neither earns ultimate nor enters the boss bounty ledger. Reflect electricity according to accepted actual object damage, including ranged/final partial hits.

Boss attacks on disguised moles use an atomic nonrevealing store operation with proportional health units and no bounty. Human attacks retain the reveal behavior. The room-wide event notice belongs below the header, not above boss models; electricity uses pooled sparks/arcs without post-processing.

## Alternatives

- Per-instance event timers would diverge and restart during runner changes; the shared schedule follows the existing NPC authority model.
- Separate object and boss writes would permit duplicated/missing support on concurrent final blows or process interruption.
- Unlimited support after IT replacement would make the boss fight optional.
- New controls, reward dialogs or boss-head-only notices would add interaction cost or hide the event from distant players.

## Consequences

The event adds one pose write per active/returning second, cached navigation work and transition broadcasts. Idle rooms have no extra polling loop. The full office becomes dangerous for 30 seconds; five seconds of global warning, ordinary telegraphs, local target acquisition and brief fresh-spawn protection preserve escape opportunities. Player HP persistence still follows the existing realtime health path. Unsaved movement can lag by up to a housekeeping interval on handover; no exact replay of an in-flight windup is promised.

## References

- [Leased runners](0002-leased-npc-runners.md), [static world](0004-static-world.md), [actor collision](0007-dynamic-actor-collision.md)
- [Balance, timing, bot and retention rules](../BOSS.md#electrified-server-racks)
- [Schedule](../../lib/office-patrol.js), [realtime](../../lib/realtime.js), [Redis store](../../lib/store-redis.js)
- [Behavior/store/multi-instance checks](../../test/office-patrol.js), [real WebGL and banner checks](../../test/office-ui.cjs)
