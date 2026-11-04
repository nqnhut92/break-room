# VKL, the boss of the server room

English · [Tiếng Việt](BOSS.vi.md) · [Architecture](ARCHITECTURE.md)

Every server (BR-1, BR-2) has one boss, **VKL**, who patrols the server room. It is the only thing in the game that can hurt a player. This page says how the fight works and, more importantly, why it was built this way, so a later change does not undo a decision by accident.

## How it plays

- The boss walks a loop inside the server room. When a player is **inside the room** (or standing in the doorway apron) it runs at the nearest one, raises its fist (0.7 s, a **red circle** on the floor shows where it will land) and punches. Anyone inside the circle when the fist lands takes 30 damage. Running out of the circle in time dodges it.
- **New Process (Quy trình mới):** every 12 seconds of combat, the boss marks a player's position with a purple circle (radius 220). After 1.2 seconds, paperwork falls and deals 20 damage to players still inside the circle and the boss zone. The marked position stays fixed, so moving away dodges it.
- Player-to-player attacks only show hit feedback and never remove health or mana.
- Players have 100 health (a bar over their head once hurt, and a pill in the top bar). Four punches knock a player out. They lie there for **15 seconds**, can still chat, and then come back at the **lobby**, never where they fell.
- Health comes back slowly: nothing for 4 seconds after a hit, then 5 per second (a full bar about 24 seconds after the last punch). Stepping out of the room and waiting is a real option.
- The boss has 6,000 health, a hammer hit does 10 (that is 600 hits) and it **does not heal**: damage sticks, so hit and run works. **A lone player can wear it down in the end but the punches make that very hard; about five players take it down in around a minute, and a crowd is not a walkover.**
- When it falls, a **500 million bounty** is added to the damage board and split by damage dealt. It is back one minute later, at its starting spot, with full health.
- It never leaves the server room: leave and it goes back to patrolling and healing. The room holds six server racks worth 120 million each, so going in is a risk worth taking.

## The numbers

All of them live in `BOSS` and `PLAYER` in [`lib/boss.js`](../lib/boss.js); nothing else hard-codes them (the client is sent them in the `welcome` message).

| Setting | Value | Why |
| --- | --- | --- |
| Player health | 100 | Four punches. Few enough to feel dangerous, enough to survive a mistake. |
| Boss punch | 30 damage, 0.7 s windup, 0.6 s recovery | "It has to hurt", but dodgeable. A player at full speed leaves the circle in about 0.29 s. |
| Boss speed | 110 patrolling, 280 chasing (players walk at 420) | You can always run away, you just cannot stand still. |
| Boss health | 6,000, hit = 10 | Tuned with the simulation below. |
| Regeneration | none | Players found a boss that heals too hard. See "Why it does not heal". |
| Player regeneration | 5 per second after 4 s | Moderate: not "never", not "instantly". |
| Player respawn | 15 s, at the lobby | Was 60 s; players found a minute too long. |
| Boss respawn | 1 min | Was a random 3 to 5 min; players found that too long. |
| Bounty | 500 million, split by damage | See "Why the bounty is split by damage". |
| Hammer reach | 150 from the boss's centre, and a clear line | The boss is big; walls and racks block the swing. |

### What the simulation says

`node test/boss.js` runs a deliberately generous model (nobody ever dies or misses, everybody swings as fast as mana allows, whichever of two swing styles is better) and prints how long the boss survives:

| Players inside | 1 | 2 | 3 | 4 | 5 | 8 | 20 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Seconds to beat the boss | never | never (> 15 min) | ~310 | ~170 | ~115 | ~115 | ~115 |

The real fight is harder than this model because players get punched, so 3 and 4 players have a real fight on their hands, 5 or more win with some losses, and 1 or 2 cannot. The test fails if these promises break, so retuning is safe: change `BOSS`, run `npm test`.

## Why it is built this way

**A separate damage scale, not "100 to 1000 times the health".** The first idea was a boss with 100 to 1000 times a player's health. Taken literally that is 10,000 to 100,000 health, but everything a player does is 1 damage per hit and the whole group manages about four hits a second, so such a boss could never die. What matters is the *time to kill*, not the ratio. So hits on the boss are worth 10 and the boss has 3,600 (36 times a player's health, 360 hits), and the numbers were chosen by the time to kill above.

**Why it does not heal (any more).** It used to recover 5 per second plus 20 per second after a pause, so one or two players could never win and a group had to stay on it. In play that was too hard and no fun: nobody could chip at it and leave. Now damage sticks, which makes hit and run a real tactic. The fight is still hard because of the punches, and the health is higher (6,000) so it stays a group effort. The regeneration code (`bossHpAt`) is still there and the two numbers are in `BOSS` (`baseRegenPerSec`, `regenPerSec`): a value above 0 brings it back, and the client uses the same formula.

**Why the hit value scales with the crowd.** If twenty friends join, a boss tuned for five would die in 30 seconds. Each hit is divided by `max(1, players in the boss's room / 5)`, so time to kill stays near two minutes however many come. The count is the players *inside the boss's zone and alive*, not everyone online, otherwise fifteen people standing in the toilets would make it stronger for the five who fight, and a big crowd outside would not matter.

**Why the boss stays in the server room.** You asked for it, and it also keeps the rest of the game safe: new players spawn in the lobby and the open office is never dangerous. It is the "boss room" of an old RPG: you choose to go in. Because it only notices people inside the room (or on the apron in front of the door), standing at the door and poking it does not turn into free hits either: the apron counts, so the boss comes out to meet you.

**Why the red circle.** "Make it hurt" and "make it fair" pull in opposite directions. Damage is large (four punches) so it matters; the 0.7 s warning makes each punch avoidable, which is what makes the damage acceptable instead of random. On a phone, tapping to walk is slower than a keyboard, so the warning is generous.

**Why players regenerate moderately.** If health never came back, one mistake would ruin a run and people would stop trying. If it came back instantly, health would mean nothing. Four seconds of calm then five a second means "retreat out of the room for 25 seconds and come back fresh", which is a tactical choice rather than a free reset.

**Why knock-out lives in the store.** If the knock-out timer were only in the connection, a page refresh would bring the player back instantly. The time they come back is stored with the player (`h<id>` in the room's name hash), so a refresh, a reconnect or a renewal after a few minutes cannot revive or heal anyone early. (A completely new identity, for example a new browser profile, still starts fresh; that is accepted for a casual game.)

**Why the bounty is split by damage.** Otherwise the person who lands the last hit (often a passer-by who tapped once) takes everything, and the rest of the group, who spent two minutes under fire, get nothing. Damage dealt is recorded per player (`bdmg`, with the amount that actually counted, so overkill does not inflate it).

**Why a hammer needs a clear line.** The server used to check only distance. With a boss behind glass, anyone outside the wall could hit it while it could not touch them. A swing now needs `clearLine` between the two (walls and furniture block it).

**Why no "Sếp" role any more.** There is now exactly one boss. The role list lost "Sếp"; old saved choices fall back to a normal employee.

**The boss's look.** The boss is drawn with the same code-built body as the players (`makePlayer` in `scene3d.js`, `gender: 'boss'`): navy suit, red tie, silver spiky hair and a gold crown, scaled by `BOSS_SCALE`. Players only choose `m` or `f`; the join screen and the server accept only those.

## How it works across instances

The game runs on several Vercel instances at once, so there must be **exactly one boss per room** and nobody may need to trust another instance's idea of where a player is.

- **One runner.** The instance that holds a short lease in the store (`blk`, 3 s, renewed every second, any instance with players in the room tries to take it) runs the boss: it walks, notices people and throws punches, and publishes snapshots. If it dies, another instance takes the lease within about 3 seconds and continues from the last snapshot. No instance has the lease while the room is empty, so an empty room costs nothing.
- **Everyone hurts their own players.** The runner publishes `bstrike` (centre and radius). Each instance checks *its own* players against the circle using their true server-side positions and takes the health off. Nobody has to guess where a remote player stands, and a player is hurt once.
- **Atomic where it must be.** A hit on the boss is one Lua script (`bossHit`): it adds the regeneration, subtracts the hit, records the damage, and on the killing blow pays the bounty and marks the boss down, all at once, so two instances landing the last hit cannot both pay. The boss's health is stored with a timestamp (`boss` hash); the player's is in the name hash.
- **Cost.** Snapshots go out 5 times a second while it walks and 10 while it fights, and only when it moved; with every player of a room on the runner's own instance they never touch Redis. Redis sees about one lease command per second per instance and room, one `HMGET` per second for the runner, and one command per hit on the boss or per punch that lands. The whole boss has no timers when the room is empty.

### Messages (server to client)

| Message | When |
| --- | --- |
| `boss` | position, heading, mode and number of players in range (the HUD uses it) |
| `bwind` | a punch starts: centre, radius, duration (the red circle) |
| `bstrike` | the fist lands |
| `bhp` | a hit on the boss, with its new health (clients add the regeneration themselves) |
| `bdead` | it fell: who did how much, the bounty each gets, time until it returns |
| `bup` | it is back |
| `hp` | a player was hurt: new health and the damage |
| `down` | a player was knocked out: milliseconds until they return |
| `up` | a player came back: where, and the new health |

From the client: `bhit` (a hammer swing at the boss; the server checks reach, line of sight, mana and cooldown, like for any object).

## Trying and tuning

Environment variables (all optional): `BOSS_DISABLED=1`, `BOSS_MAX_HP=300` (a boss that falls in 30 hits), `BOSS_RESPAWN_MS=5000`, `PLAYER_RESPAWN_MS=5000`.

Tests: `test/boss.js` (rules, balance), `test/boss-net.js` (a whole fight over WebSockets), `test/shared.js` (the same store contract on memory and a real Redis, plus a fight across two instances).

## Known limits and ideas

- A player who throws away their identity gets full health. Fine for this game; a per-IP cool-down would be the next step.
- Someone idle in the server room is an easy target: they are knocked out and wait 15 seconds.
- No knockback: the punch is damage and screen shake only. Adding it needs the server to move the player and tell the client.
- A damage board of boss kills is not kept; bounties go into the normal damage board.

## Hidden snake waves and drinks

At 70%, 40% and 10% health, once per threshold per boss life, VKL summons one small green snake per online player in the server. Snakes follow the nearest living player through doorways across the entire office. Each has 4 health, takes one damage per hammer hit, moves at 200 units/second and bites for 5 damage with a 1.2-second cooldown. Remaining snakes are cleared when the boss respawns. Wave claims and snake health are atomic in Redis; one leader moves them, clients draw and interpolate them. Positions are saved once per second.

Every five minutes the room offers “Đồng nghiệp mời nước” for five seconds. One accepted click restores all connected players to full health and mana; downed players revive in the lobby. The schedule and claim are shared across instances.

## Captured 1:1 duel

Every random 40–60 seconds, VKL selects one living player inside the server room or within 320 units of its boundary. With no eligible player, that attempt is skipped and another is scheduled 40–60 seconds later. A rope pulls the captive inside; a gust blows other living occupants into the west corridor.

For 15 seconds the captive can move and fight inside but cannot leave. Spectators cannot enter, damage the boss or receive its strikes. Expiry, boss death or captive death opens the room. Disconnecting does not clear capture; reconnecting restores the remaining timer. The boss lease holder commits the versioned schedule and forced positions atomically in the shared store.

Snakes have a continuous S-shaped body, a tapered tail and a forked tongue. Summoning raises the boss's hands and displays green spell rings, using reused geometry without post-processing.

Tests: `test/duel.js` (rules, timing, boundaries), `test/duel-realtime.js` (two instances, reconnects and leader handover), `test/shared.js` (memory/Redis store contract).
