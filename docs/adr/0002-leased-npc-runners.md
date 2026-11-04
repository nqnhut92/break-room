# 0002 — Leased NPC runners with fenced state updates

- Status: Accepted
- Recorded: 2026-11-04 (existing decision documented retrospectively)
- Supersedes / superseded by: none

## Context

Several instances can hold players in one room. If each independently advances NPC behavior, movement, strikes, respawns and duels can run more than once. An instance can also disappear or finish a delayed write after another runner takes over.

## Decision

Use the room's expiring boss lease to select the authoritative NPC runner. Other instances relay its updates and apply applicable damage to their own local players. Persist the state needed for handover. Fence runner-owned durable updates with lease ownership and, where implemented, expected versions so delayed writes cannot overwrite newer mini-boss or duel state. Hits and bounty payments remain atomic store operations.

Clients interpolate and animate the received state; rendering does not determine combat outcomes.

## Alternatives

- Independent runners per instance risk duplicate or divergent actions.
- A permanently dedicated room process would simplify ownership but needs separate hosting and recovery infrastructure.
- Client-owned NPC simulation would give browsers authority over shared combat.

## Consequences

Rooms can recover from runner loss without permanent process affinity. Lease expiry and version conflicts introduce handover delays and retry logic. A lease does not make every transient broadcast exactly-once; durable commits, payouts and client visual interpolation have different guarantees. Changes must test stale owners, competing commits and handovers across instances.

## References

- [VKL implementation notes](../BOSS.md), [mini-boss rules](../MINIBOSSES.md)
- [Runner orchestration](../../lib/realtime.js), [Redis operations](../../lib/store-redis.js)
- [Mini-boss tests](../../test/miniboss.js), [duel tests across instances](../../test/duel-realtime.js), [store tests](../../test/shared.js)
