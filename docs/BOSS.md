# VKL, the boss of the server room

English · [Tiếng Việt](BOSS.vi.md) · [Architecture](ARCHITECTURE.md)

Every server (BR-1, BR-2) has one boss, **VKL**, who patrols the server room. This page says how the fight works and, more importantly, why it was built this way, so a later change does not undo a decision by accident.

## How it plays

- The boss walks a loop inside the server room. When a player is **inside the room** (or standing in the doorway apron) it runs at the nearest one, raises its fist (0.7 s, a **red circle** on the floor shows where it will land) and punches. Anyone inside the circle when the fist lands takes 30 damage. Running out of the circle in time dodges it.
- **New Process (Quy trình mới):** every 12 seconds of combat, the boss marks a player's position with a purple circle (radius 350). After 1.2 seconds, paperwork falls and deals 20 damage to players still inside the circle and the boss zone. The marked position stays fixed, so moving away dodges it.
- Player-to-player attacks only show hit feedback and never remove health or mana.
- Players have 100 health (a bar over their head once hurt, and a pill in the top bar). Four punches knock a player out. They lie there for **15 seconds**, can still chat, and then come back at the **lobby**, never where they fell.
- Health comes back slowly: nothing for 4 seconds after a hit, then 5 per second (a full bar about 24 seconds after the last punch). Stepping out of the room and waiting is a real option.
- The boss starts at 6,000 health for 1–4 real players online in the room. Each further group of four adds 3,000 maximum and current HP after 15 seconds of sustained presence. Damage already dealt sticks; there is no passive regeneration. A hammer/electric hit always does 10, milk tea 5, and ultimate deals 20% of the current maximum HP.
- When it falls, a **500 million bounty** is added to the damage board and split by damage dealt. It is back one minute later, at its starting spot, with full health.
- Outside the office patrol event it stays in the server room: leave and it goes back to patrolling without healing. The room holds six server racks worth 120 million each, so going in is a risk worth taking.

## The numbers

Combat settings live in `BOSS` and `PLAYER` in [`lib/boss.js`](../lib/boss.js); population tiers live in [`lib/boss-population.js`](../lib/boss-population.js). Clients receive current/max HP, not private population counters.

| Setting | Value | Why |
| --- | --- | --- |
| Player health | 100 | Four punches. Few enough to feel dangerous, enough to survive a mistake. |
| Boss punch | 30 damage, 0.7 s windup, 0.6 s recovery | "It has to hurt", but dodgeable. A player at full speed leaves the circle in about 0.29 s. |
| Boss speed | 220 patrolling, 480 chasing (players walk at 420) | On clear floor the boss catches a fleeing player; dodge during windup and counter during recovery. Outside the office patrol event, leaving the boss zone still ends pursuit. |
| Boss health | 6,000 for 1–4 humans; +3,000 per next group of four | Preserves damage already dealt as the room grows. |
| Ultimate | 20% of current max HP | Applies to VKL, TML and DMM; charge rate is unchanged. |
| Regeneration | none | Players found a boss that heals too hard. See "Why it does not heal". |
| Player regeneration | 5 per second after 4 s | Moderate: not "never", not "instantly". |
| Player respawn | 15 s, at the lobby | Was 60 s; players found a minute too long. |
| Boss respawn | 1 min | Was a random 3 to 5 min; players found that too long. |
| Bounty | 500 million, split by damage | See "Why the bounty is split by damage". |
| Hammer reach | 150 from the boss's centre, and a clear line | The boss is big; walls and racks block the swing. |

### What the simulation says

`node test/boss.js` runs a deliberately generous model (nobody ever dies or misses, everybody swings as fast as mana allows, whichever of two swing styles is better) and prints how long the boss survives:

| Humans online, all attacking | 1 | 2 | 3 | 4 | 5 | 8 | 20 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Seconds to beat the boss | ~373 | ~186 | ~121 | ~93 | ~108 | ~68 | ~54 |

This model starts at the population tier for that group and excludes ultimates, racks, enemy attacks and travel. Real fights depend on dodging and participation: online players elsewhere still count for HP. A tier boundary can make five players slower than four. These are simulation results, not measured live fight times. Run `npm run test:redis` after changing server rules.

## Why it is built this way

**A separate damage scale, not "100 to 1000 times the health".** The first idea was a boss with 100 to 1000 times a player's health. Taken literally that is 10,000 to 100,000 health, but everything a player does is 1 damage per hit and the whole group manages about four hits a second, so such a boss could never die. What matters is the *time to kill*, not the ratio. Hits on the boss use their own damage scale (10 for a hammer); maximum HP now follows the population tiers above.

**Why it does not heal (any more).** It used to recover 5 per second plus 20 per second after a pause, so one or two players could never win and a group had to stay on it. In play that was too hard and no fun: nobody could chip at it and leave. Now damage sticks, which makes hit and run a real tactic. The fight is still hard because of the punches, and the base health is 6,000 before population growth so it stays a group effort. The regeneration code (`bossHpAt`) is still there and the two numbers are in `BOSS` (`baseRegenPerSec`, `regenPerSec`): a value above 0 brings it back, and the client uses the same formula.

### Population health

Maximum HP is 6,000 / 9,000 / 12,000 / 15,000 / 18,000 for 1–4 / 5–8 / 9–12 / 13–16 / 17–20 real players online in the room. Count authoritative fresh presence across all instances, including downed players and people outside the boss zone. Count a player ID once; concealed/revealed moles and summoned snakes do not count. Separate guest identities/accounts remain separate players; this does not identify distinct people behind them.

Each newly reached tier must remain reached for 15 seconds, observed by the runner each second. Each threshold has its own timer, so dropping from nine to five does not erase progress toward the five-player tier. A gap over three seconds without an observation restarts pending timers. On growth, add the maximum-HP difference to current HP: 300/6,000 becomes 3,300/9,000. Do not reset the damage ledger, rack markers or snake-wave markers. Maximum HP never decreases during a life, and rejoining the same tier adds nothing. Respawn resets to the tier of currently present humans, at full HP. A newly created room starts at base HP and confirms growth normally.

The previous crowd-based damage reduction is removed. Ultimate computes 20% of stored maximum HP atomically with the hit, so another instance cannot use a stale maximum. Rack support uses 2% of the maximum when that rack breaks; already consumed racks are not recalculated on growth. Each 70/40/10% snake wave can still happen only once per life.

Only current/max HP and a health revision reach clients. No human count, tier timer or bot classification is exposed. Bucketed delayed growth reduces immediate join-to-HP clues, but public HP plus public online counts can still support inference; it is not a secrecy guarantee. See [ADR 0010](adr/0010-population-boss-health.md).

**Why the boss normally stays in the server room.** Outside the announced office patrol, the room remains an opt-in boss fight. The later patrol event deliberately makes the open office dangerous for a short, announced period. Because it only notices people inside the room (or on the apron in front of the door), standing at the door and poking it does not turn into free hits either: the apron counts, so the boss comes out to meet you.

**Why the red circle.** "Make it hurt" and "make it fair" pull in opposite directions. Damage is large (four punches) so it matters; the 0.7 s warning makes each punch avoidable, which is what makes the damage acceptable instead of random. On a phone, tapping to walk is slower than a keyboard, so the warning is generous.

**Why players regenerate moderately.** If health never came back, one mistake would ruin a run and people would stop trying. If it came back instantly, health would mean nothing. Four seconds of calm then five a second means "retreat out of the room for 25 seconds and come back fresh", which is a tactical choice rather than a free reset.

**Why knock-out lives in the store.** If the knock-out timer were only in the connection, a page refresh would bring the player back instantly. The time they come back is stored with the player (`h<id>` in the room's name hash), so a refresh, a reconnect or a renewal after a few minutes cannot revive or heal anyone early. (A completely new identity, for example a new browser profile, still starts fresh; that is accepted for a casual game.)

**Why the bounty is split by damage.** Otherwise the person who lands the last hit (often a passer-by who tapped once) takes everything, and the rest of the group, who spent two minutes under fire, get nothing. Damage dealt is recorded per player (`bdmg`, with the amount that actually counted, so overkill does not inflate it).

**Why a hammer needs a clear line.** The server used to check only distance. With a boss behind glass, anyone outside the wall could hit it while it could not touch them. A swing now needs `clearLine` between the two (walls and furniture block it).

**Why no "Sếp" player role any more.** VKL is a dedicated NPC rather than a selectable player appearance. The role list lost "Sếp"; old saved choices fall back to a normal employee. TML and DMM are separate NPC mini-bosses.

**The boss's look.** The boss is drawn with the same code-built body as the players (`makePlayer` in `scene3d.js`, `gender: 'boss'`): navy suit, red tie, silver spiky hair and a gold crown, scaled by `BOSS_SCALE`. Players only choose `m` or `f`; the join screen and the server accept only those.

## How it works across instances

The game runs on several Vercel instances at once, so there must be **exactly one boss per room** and nobody may need to trust another instance's idea of where a player is.

- **One runner.** The instance that holds a short lease in the store (`blk`, 3 s, renewed every second, any instance with players in the room tries to take it) runs the boss: it walks, notices people and throws punches, and publishes snapshots. If it dies, another instance takes the lease within about 3 seconds and continues from the last snapshot. No instance has the lease while the room is empty, so an empty room costs nothing.
- **Everyone hurts their own players.** The runner publishes `bstrike` (centre and radius). Each instance checks *its own* players against the circle using their true server-side positions and takes the health off. Nobody has to guess where a remote player stands, and a player is hurt once.
- **Atomic where it must be.** A hit on the boss is one Lua script (`bossHit`): it adds the regeneration, subtracts the hit, records the damage, and on the killing blow pays the bounty and marks the boss down, all at once, so two instances landing the last hit cannot both pay. The boss's health is stored with a timestamp (`boss` hash); the player's is in the name hash.
- **Cost.** Snapshots go out 5 times a second while it walks and 10 while it fights, and only when it moved; with every player of a room on the runner's own instance they never touch Redis. Redis sees about one lease command per second per instance and room, one atomic presence/HP scale check per second for the runner, and one command per hit on the boss or per punch that lands. The whole boss has no timers when the room is empty.

### Messages (server to client)

| Message | When |
| --- | --- |
| `boss` | position, heading, mode and number of players in range (the HUD uses it) |
| `bwind` | a punch starts: centre, radius, duration (the red circle) |
| `bstrike` | the fist lands |
| `bhp` | health change from a hit, rack or population growth: current/max HP and monotonic health revision; older revisions are ignored |
| `bdead` | it fell: who did how much, the bounty each gets, time until it returns |
| `bup` | it is back, with the new life’s maximum HP and health revision |
| `hp` | a player was hurt: new health and the damage |
| `down` | a player was knocked out: milliseconds until they return |
| `up` | a player came back: where, and the new health |

From the client: `bhit` (a hammer swing at the boss; the server checks reach, line of sight, mana and cooldown, like for any object).

## Trying and tuning

Environment variables (all optional): `BOSS_DISABLED=1`, `BOSS_MAX_HP=300` (base HP for 1–4 humans; each next group adds 50% of that base), `BOSS_RESPAWN_MS=5000`, `PLAYER_RESPAWN_MS=5000`.

Tests: `test/boss.js` (rules, balance), `test/boss-net.js` (a whole fight over WebSockets), `test/shared.js` (the same store contract on memory and a real Redis, plus a fight across two instances).

## Known limits and ideas

- A player who throws away their identity gets full health. Fine for this game; a per-IP cool-down would be the next step.
- Someone idle in the server room is an easy target: they are knocked out and wait 15 seconds.
- No knockback: the punch is damage and screen shake only. Adding it needs the server to move the player and tell the client.
- A damage board of boss kills is not kept; bounties go into the normal damage board.

## Hidden snake waves and drinks

At 70%, 40% and 10% health, once per threshold per boss life, VKL summons a random integer number of small green snakes between `ceil(1.3 × online players)` and `2 × online players` in the server at the 70% and 40% thresholds. The final wave at 10% instead summons red snakes, a random integer from `2 × online players` to `3 × online players`. Every wave has at least one snake. Snakes follow the nearest living player through doorways across the entire office. Each has 4 health, takes one damage per hammer hit, moves at 200 units/second and bites for 5 damage (green) or 7 damage (red) with a 1.2-second cooldown. Remaining snakes are cleared when the boss respawns. Wave claims and snake health are atomic in Redis; one leader moves them, clients draw and interpolate them. Positions are saved once per second.

Every five minutes the room offers “Đồng nghiệp mời nước” for five seconds. One accepted click restores all connected players to full health and mana; downed players revive in the lobby. The schedule and claim are shared across instances.

## Captured 1:1 duel

Every random 40–60 seconds, VKL selects one living player inside the server room or within 320 units of its boundary. With no eligible player, that attempt is skipped and another is scheduled 40–60 seconds later. A rope pulls the captive inside; a gust blows other living occupants into the west corridor.

For 20 seconds the captive can move and fight inside but cannot leave. Spectators cannot enter, damage the boss or receive its strikes. After the first 10 seconds, only the captive sees an “Em xin lỗi” button; clicking it opens the room early. The server validates the captive, duel version and elapsed time, including across instances. Expiry, boss death or captive death opens the room. Disconnecting does not clear capture; reconnecting restores the remaining timer. The boss lease holder commits the versioned schedule and forced positions atomically in the shared store.

Snakes have a continuous S-shaped body, a tapered tail and a forked tongue. Summoning raises the boss's hands and displays green spell rings, using reused geometry without post-processing.

Tests: `test/duel.js` (rules, timing, boundaries), `test/duel-realtime.js` (two instances, reconnects and leader handover), `test/shared.js` (memory/Redis store contract).

VKL has a solid living body for player movement and avoids living targets when walking; its defeated body is nonblocking. Body collision does not change attack timing or damage.


## Electrified server racks

All six server racks retain 8 object HP and the 120-million break reward. Each accepted hit returns 5 player HP per point of actual object damage, capped by the rack's remaining HP; milk tea therefore shocks for 2.5 HP across 16 half-damage hits. A full rack costs 40 HP and 40 mana with hammer/electric, or 40 HP and 80 mana with milk tea. A refused hit on an already broken rack costs neither health nor mana. Sparks and a short electric arc connect the rack to the attacker, alongside the normal HP-loss feedback. No extra action is required.

Breaking a rack removes 2% of VKL’s stored maximum HP at that moment, once per physical rack per boss life. At the base 6,000 maximum this is 120 HP per rack and 720 HP for all six; at 9,000 it is 180 per rack. Previously consumed racks are not recalculated when population raises the maximum. Six racks contribute at most 12% of the life’s highest maximum. IT replacement, manual reset, reconnects and runner changes do not re-arm this damage; boss respawn does. Damage stops at 1 boss HP, contributes no ultimate charge or boss-bounty credit, and is not banked while VKL is dead. The normal rack reward still applies. The rack break, money, consumed support marker and boss damage commit in the same gameplay Lua script (or RAM operation). A lethal shock still permits the already committed break/reward/support. Existing snake thresholds also react to support damage.

## Office patrol

After 3–5 minutes with players in the room, a banner directly below the header warns for 5 seconds: “Ban lãnh đạo xuống lắng nghe. Bằng nắm đấm.” VKL then leaves the server room and joins TML/DMM in hunting nearby living players for 30 seconds. Boss damage, speed and attack telegraphs stay unchanged; distant targets are not tracked globally. Minis prefer targets not already selected by another boss when alternatives are nearby. VKL uses ordinary punches during the event, not New Process or captured duels. A pending duel postpones the warning. Dead bosses are not revived for the event, and VKL dying mid-event does not end the minis' remaining patrol.

At the end, VKL walks home along navigable floor without attacking; minis cancel patrol windups and resume their existing provocation rules. The next 3–5-minute interval starts when VKL returns (or is dead). Missing a whole warning/event while a room is inactive does not replay it. Fresh lobby arrivals and respawns have 3 seconds of patrol-strike protection; attacking ends this protection. Reconnects away from the lobby do not grant it.

Concealed moles are valid patrol targets and flee instead of stabbing during the event. Boss damage uses the same health fraction as a human (30/100 costs 2.4 of the mole's internal 8 HP), without revealing the mole or paying a kill bounty. Unrevealed moles recover health after the same 4-second delay at the equivalent of 5 human HP/s. A knocked-out mole shows the ordinary down animation, records its knock-out and leaves after the 15-second down timer. A human attack still reveals it; already exposed moles keep their identity.

The office schedule/version and roaming pose live in the existing boss hash and use the existing boss lease. Transitions are broadcast; active/returning poses save once a second for runner handover. Joining/reconnecting receives the current event and its original deadline. Idle schedules do not write every tick, and empty rooms run no patrol loop or extra Redis connection. `lib/office-patrol.js` owns timing; tests can override `patrolOpts` without production environment switches.

On desktop, VKL displays “Mọi người nghĩ dì dẫy?” directly under its name. Touch/mobile labels omit the motto.
