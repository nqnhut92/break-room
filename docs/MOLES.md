# Moles ("bạn sếp nằm vùng")

English · [Tiếng Việt](MOLES.vi.md)

A mole is a fake player the server drives. It joins a room through the same door as everybody else (a slot, a random name written the way people type them (nicknames, `tuan97`, `hoa_qa`, an initial), a role, a place in the online count and the ranking) and looks like any colleague. Nothing on the wire says what it is.

- **Spawn.** The instance that leads a room (the one holding the boss lease) adds one every 1–3 minutes, never more than half the number of real players (3 moles at 6 players), and always leaves one slot free. A real player who finds the room full takes the place of a mole.
- **Mingling.** For 20–90 s it walks the office (same navigation grid as the snakes) and smashes things like a player would. It does not chat or use emoji.
- **The stab.** Then it walks to someone (whoever has been hurting the boss first, otherwise anyone) and stabs with no warning: `-30` HP. That gives it away: it gets a `🐍 BẠN SẾP` label and a health bar, keeps chasing with the default hammer (`-20` per hit) and leaves after 40 s, or after 4 minutes whatever happens.
- **Finding out by hitting.** Hitting a real person is free and only cosmetic. Hitting a mole costs mana like any object and reveals it. Its health and its bounty are those of a server cabinet (8 and 120). The bounty goes to whoever lands the last blow.
- **Where it lives.** `lib/moles.js` is pure behaviour (tested without sockets). `lib/realtime.js` runs it (`moleTick`, `spawnMole`, `hitMole`). The secret (health, revealed or not) is in the store's `moles` hash (`moleAdd/moleList/moleReveal/moleHit/moleDel`), so a hit on any instance is atomic. A new leader sends the previous leader's moles home.
- **Tuning.** `MOLE_DISABLED=1` turns them off; `MOLE_SPAWN_MS=5000` makes one arrive every 5 s (for trying it). Tests shrink the timings through the `moleSpawnMs` and `moleOpts` options.
- **Day board.** A mole has a row on the room's daily board from its first appearance, exactly like a player, and keeps it as an offline row after it leaves. Its participant id is random and server-only; nothing in a board, join or chat message says what it is. See [Scores](SCORES.md).
