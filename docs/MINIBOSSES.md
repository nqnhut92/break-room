# TML and DMM

Each room has one of each mini-boss. They wander throughout reachable floor, including the main boss area, and never initiate combat. TML has a compact silhouette; DMM is broader. Both are smaller than VKL and use the existing rounded, code-built character rig.

| Setting | TML | DMM |
| --- | --- | --- |
| HP | 900 | 600 |
| Damage | 20 | 15 |
| Windup | 850 ms | 650 ms |
| Recovery | 1,000 ms | 800 ms |
| Chase speed | 230 | 260 |
| Bounty (million VND) | 40 | 30 |

A hammer/electric hit does 10 damage; milk tea does 5 with twice the reach. Ordinary hits spend normal mana and add 1 rage. Ultimate deals 15% of the target's maximum HP and consumes the bar. A reachable mini-boss takes priority over VKL/moles for ultimate targeting, choosing the nearest mini-boss. HP does not regenerate or scale with online players. The name, health bar and numeric current/max HP are always shown overhead while alive.

Only people who damage a mini-boss enter its threat list. The other mini-boss stays neutral. Damage over the recent eight seconds determines target priority; proximity breaks ties. Telegraph circles stay fixed through the windup, so players can dodge. Strikes can only hurt living aggressors in the circle with an unobstructed line from the mini-boss. Bystanders cannot be harmed by dragging one over them. Dead/disconnected players leave the threat list. After eight seconds without taking damage, if all aggressors are at least 600 units away, the mini-boss forgets them and resumes wandering.

A kill pays the bounty proportionally to actual damage, capped at remaining HP; it credits the regular damage board. After exactly 30 seconds it becomes eligible to respawn with full HP and a fresh threat/damage ledger. The next simulation tick (normally within 200 ms) chooses another random floor position, at least 240 units from the death location/other living mini-boss and 180 from living players when possible. Positions are selected from a collision-tested navigation graph connected to the lobby. A room without an active runner resumes overdue respawns when a runner returns.

`lib/miniboss.js` holds rules and navigation. `lib/realtime.js` drives the room on its existing boss lease, independently of VKL's life or `BOSS_DISABLED`. The memory and Redis stores use a versioned compare-and-swap document for both mini-bosses. Hits retry conflicting writes; simulation commits are fenced by the lease. HP, threat, damage credit, windup/recovery and respawn deadlines survive reconnects and leader handover. Payout and the killing state commit atomically. Clients interpolate snapshots; single-instance movement snapshots bypass Redis pub/sub, while state still persists in the store.

Verification: `test/miniboss.js` covers rules/navigation and real WebSocket combat. `test/shared.js` exercises the store contract against both memory and Redis, plus two-server kills and respawn. Run `npm run test:redis` for the complete suite.

Living TML/DMM bodies block player movement and avoid living characters while wandering/chasing. Defeated bodies are nonblocking. Touching a neutral mini-boss does not add threat or cause retaliation; only the existing aggression rules do.
